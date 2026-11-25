import { characterList, selectedCharacter } from "./storage/characterStore.svelte";
import { chatEntry, currentChatRef } from "./storage/chatStore.svelte";
import { settings, activePreset, tabPersonaRecord } from "./storage/settingsViews.svelte";
import { get, writable, type Writable } from "svelte/store";
import type { Message } from "./storage/database.svelte";
import { createBlankChar, getCharImage } from "./characters";
import { isIOS } from "src/ts/platform";
import type { Attachment } from "svelte/attachments";
import { mount, unmount, type Snippet } from "svelte";
import PopupList from "src/lib/UI/PopupList.svelte";

/**
 * Client presentation helpers, file pickers, text/byte conversions and browser storage utilities.
 * Character and preset helpers read the live selection; persona helpers accept a stable chat
 * reference for rendering another chat, falling back to the tab persona when no bound one exists
 * (src/ts/storage/chatStore.svelte.ts and src/ts/storage/settingsViews.svelte.ts).
 * File selection uses DOM inputs and preserves eligible-file order; byte reads and IndexedDB calls
 * can reject. These browser helpers are separate from the deterministic server-shared re-exports
 * in shared/hashRand.ts and shared/prompt/toggles.ts.
 */

/** Shared with the server so CBS and lore pick the same random values. */
export { pickHashRand, sfc32 } from "../../shared/hashRand.ts";
/** Shared parser for sidebar-toggle prompt syntax. */
export { parseToggleSyntax } from "../../shared/prompt/toggles.ts";
/** Sidebar-toggle records returned by shared/prompt/toggles.ts. */
export type { sidebarToggle, sidebarToggleGroup, sidebarToggleGroupEnd } from "../../shared/prompt/toggles.ts";

/** A displayed message with its original index before `messageForm` reverses and limits the list. */
export interface Messagec extends Message {
    index: number;
}

/** Copies display fields newest first, trims message text and limits to loadPages, keeping original indices. */
export function messageForm(arg: Message[], loadPages: number) {
    function reformatContent(data: string) {
        return data?.trim();
    }

    let a: Messagec[] = [];
    for (let i = 0; i < arg.length; i++) {
        const m = arg[i];
        a.unshift({
            role: m.role,
            data: reformatContent(m.data),
            index: i,
            saying: m.saying,
            chatId: m.chatId ?? "none",
            generationInfo: m.generationInfo,
        });
    }
    return a.slice(0, loadPages);
}

/** Resolves after a timeout of ms milliseconds. */
export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A delay whose timer and listener are released on completion or cancellation. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Whether data is null or undefined. */
export function checkNullish(data: any) {
    return data === undefined || data === null;
}

/** Reads the selected File into `{ name, data: Uint8Array }`; null on cancel or an empty eligible selection. */
export async function selectSingleFile(ext: string[]) {
    const file = await selectSingleFileHandle(ext);
    if (!file) {
        return null;
    }
    return { name: file.name, data: await readFileAsUint8Array(file) };
}

/**
 * Returns the DOM-picked File unread, or null for an empty eligible change.
 * `src/ts/process/modules.ts` passes `.risum` and `.charx` Files to server imports;
 * `src/ts/process/transformers.ts` uses `src/ts/process/zipFile.ts` to read VITS model zips in slices.
 */
export async function selectSingleFileHandle(ext: string[]): Promise<File | null> {
    const files = await selectFileByDom(ext, "single");
    return files?.[0] ?? null;
}

/**
 * Returns DOM-picked Files unread, or [] for an empty eligible change.
 * `src/ts/storage/assetQueue.ts`'s savePickedFiles reads each only after load admission.
 */
export async function selectMultipleFileHandles(ext: string[]): Promise<File[]> {
    return (await selectFileByDom(ext, "multiple")) ?? [];
}

/** Reads eligible Files in selection order into `{ name, data: Uint8Array }` entries; [] for an empty change. */
export async function selectMultipleFile(ext: string[]) {
    const v = await selectFileByDom(ext, "multiple");
    let arr: { name: string; data: Uint8Array }[] = [];
    for (const file of v) {
        arr.push({ name: file.name, data: await readFileAsUint8Array(file) });
    }
    return arr;
}

/** Replaces character markers with the supplied name, selected name, or ""; replaces user markers and removes set/get-var markers. */
export const replacePlaceholders = (msg: string, name?: string) => {
    const charName = name ?? selectedCharacter()?.name ?? "";
    return msg
        .replace(/({{char}})|({{Char}})|(<Char>)|(<char>)/gi, charName)
        .replace(/({{user}})|({{User}})|(<User>)|(<user>)/gi, getUserName())
        .replace(/(\{\{((set)|(get))var::.+?\}\})/gu, "");
};

/**
 * The persona bound to `chatRef`'s chat (default: the selected chat), or null. Read from the chat's
 * list entry, so it holds also while the chat is not loaded.
 */
export function checkPersonaBinded(chatRef?: { chaId: string; chatId: string } | null) {
    try {
        const ref = chatRef ?? currentChatRef();
        const chat = ref ? chatEntry(ref) : undefined;
        if (!chat?.bindedPersona) {
            return null;
        }
        const persona = settings.personas.find((v) => v.id === chat.bindedPersona);
        return persona;
    } catch (error) {
        return null;
    }
}

/**
 * The persona a render of `chatRef`'s chat (default: the selected chat) shows: its bound persona
 * when that exists, else the tab's selected persona, never the selected chat's when `chatRef` names
 * another chat.
 */
function displayPersona(chatRef?: { chaId: string; chatId: string } | null) {
    return checkPersonaBinded(chatRef) ?? tabPersonaRecord();
}

/** Displayed persona's name for the given or selected chat, falling back to "User". */
export function getUserName(chatRef?: { chaId: string; chatId: string } | null) {
    return displayPersona(chatRef)?.name ?? "User";
}

/** Displayed persona's icon for the given or selected chat, falling back to "". */
export function getUserIcon(chatRef?: { chaId: string; chatId: string } | null) {
    return displayPersona(chatRef)?.icon ?? "";
}

/** Displayed persona's prompt for the given or selected chat, falling back to "". */
export function getPersonaPrompt(chatRef?: { chaId: string; chatId: string } | null) {
    return displayPersona(chatRef)?.personaPrompt ?? "";
}

/** Displayed persona's large-portrait flag for the given or selected chat; false when absent or reading fails. */
export function getUserIconProtrait(chatRef?: { chaId: string; chatId: string } | null) {
    try {
        return displayPersona(chatRef)?.largePortrait ?? false;
    } catch (error) {
        return false;
    }
}

/**
 * Resolves eligible Files in selection order on change, or [] on cancel or an empty eligible selection.
 * Filtering is bypassed by allow-all, iOS, or `allowedExtensions[0] === "*"`.
 * Removes the input before settling.
 */
export function selectFileByDom(allowedExtensions: string[], multiple: "multiple" | "single" = "single") {
    return new Promise<null | File[]>((resolve) => {
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = multiple === "multiple";
        const acceptAll = settings.ui.allowAllExtentionFiles || isIOS() || allowedExtensions[0] === "*";
        if (!acceptAll) {
            if (allowedExtensions && allowedExtensions.length) {
                fileInput.accept = allowedExtensions.map((ext) => `.${ext}`).join(",");
            }
        } else {
            fileInput.accept = "*";
        }

        fileInput.addEventListener("change", () => {
            fileInput.remove();
            if (fileInput.files.length === 0) {
                resolve([]);
                return;
            }

            const files = acceptAll
                ? Array.from(fileInput.files)
                : Array.from(fileInput.files).filter((file) => {
                      const fileExtension = file.name.split(".").pop().toLowerCase();
                      return !allowedExtensions || allowedExtensions.includes(fileExtension);
                  });

            resolve(files);
        });

        fileInput.addEventListener("cancel", () => {
            fileInput.remove();
            resolve([]);
        });

        document.body.appendChild(fileInput);
        fileInput.click();
        fileInput.style.display = "none"; // Hide the file input element
    });
}

function readFileAsUint8Array(file: File) {
    return new Promise<Uint8Array>((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (event) => {
            const buffer = event.target.result;
            const uint8Array = new Uint8Array(buffer as ArrayBuffer);
            resolve(uint8Array);
        };

        reader.onerror = () => {
            reject(new Error("Failed to read file", { cause: reader.error }));
        };

        reader.readAsArrayBuffer(file);
    });
}

/** Returns cover-background CSS for an image path, or "" for a path shorter than two characters. */
export async function getCustomBackground(db: string) {
    if (db.length < 2) {
        return "";
    } else {
        const filesrc = await getCharImage(db, "plain");
        return `background: url("${filesrc}"); background-size: cover;`;
    }
}

/** Finds a non-group character; a miss returns a new blank character named "Unknown Character". */
export function findCharacterbyId(id: string) {
    for (const char of characterList()) {
        if (char.type !== "group") {
            if (char.chaId === id) {
                return char;
            }
        }
    }
    let unknown = createBlankChar();
    unknown.name = "Unknown Character";
    return unknown;
}

/** Current list index (groups included), or -1; an index must not be retained as an address across awaits. */
export function findCharacterIndexbyId(id: string) {
    let i = 0;
    for (const char of characterList()) {
        if (char.chaId === id) {
            return i;
        }
        i += 1;
    }
    return -1;
}

/** Maps every current character/group id to its list index; indices are valid only for that list snapshot. */
export function getCharacterIndexObject() {
    let i = 0;
    let result: { [key: string]: number } = {};
    for (const char of characterList()) {
        result[char.chaId] = i;
        i += 1;
    }
    return result;
}

/** An asset tuple's (`[name, path, ext?]`) extension: its stored one, else its path's. */
export function assetExtension(asset: readonly string[]): string {
    return asset.length > 2 && asset[2] ? asset[2] : (asset[1].split(".").pop() ?? "");
}

/** How many asset rows an asset list renders at first and adds per "Load More". */
export const ASSET_LIST_PAGE = 100;

/** Returns the first neutral emotion's image path, or "" when none exists. */
export function defaultEmotion(em: readonly (readonly [string, string])[]) {
    if (!em) {
        return "";
    }
    for (const v of em) {
        if (v[0] === "neutral") {
            return v[1];
        }
    }
    return "";
}

/**
 * Returns [] or a mode (emp/normal) followed by render values; depending on type/branch those values
 * can be image URLs, CSS declarations, or a missing image value.
 */
export async function getEmotion(
    chaEmotion: { [key: string]: [string, string, number][] },
    type: "contain" | "plain" | "css",
) {
    const currentDat = selectedCharacter();
    if (!currentDat) {
        return [];
    }
    let charIdList: string[] = [];

    if (currentDat.type === "group") {
        if (currentDat.characters.length === 0) {
            return [];
        }
        switch (currentDat.viewScreen) {
            case "multiple":
                charIdList = currentDat.characters;
                break;
            case "single": {
                let newist: [string, string, number] = ["", "", 0];
                let newistChar = currentDat.characters[0];
                for (const currentChar of currentDat.characters) {
                    const cha = chaEmotion[currentChar];
                    if (cha) {
                        const latestEmotion = cha[cha.length - 1];
                        if (latestEmotion && latestEmotion[2] > newist[2]) {
                            newist = latestEmotion;
                            newistChar = currentChar;
                        }
                    }
                }
                charIdList = [newistChar];
                break;
            }
            case "emp": {
                charIdList = currentDat.characters;
                break;
            }
        }
    } else {
        charIdList = [currentDat.chaId];
    }

    let datas: string[] = [currentDat.viewScreen === "emp" ? "emp" : ("normal" as const)];
    for (const chaid of charIdList) {
        const currentChar = findCharacterbyId(chaid);
        if (currentChar.viewScreen === "emotion") {
            const currEmotion = chaEmotion[currentChar.chaId];
            let im = "";
            if (!currEmotion || currEmotion.length === 0) {
                im = await getCharImage(defaultEmotion(currentChar?.emotionImages), type);
            } else {
                im = await getCharImage(currEmotion[currEmotion.length - 1][1], type);
            }
            if (im && im.length > 2) {
                datas.push(im);
            }
        } else if (currentChar.viewScreen === "imggen") {
            const currEmotion = chaEmotion[currentChar.chaId];
            if (!currEmotion || currEmotion.length === 0) {
                datas.push(await getCharImage(currentChar.image ?? "", "plain"));
            } else {
                datas.push(currEmotion[currEmotion.length - 1][1]);
            }
        }
    }
    return datas;
}

/** Returns the first author-note template item's default text in the active prompt preset, or "". */
export function getAuthorNoteDefaultText() {
    const template = activePreset.promptTemplate;
    if (!template) {
        return "";
    }

    for (const v of template) {
        if (v.type === "authornote") {
            return v.defaultText ?? "";
        }
    }
    return "";
}

/** AES-GCM ciphertext/tag ArrayBuffer using SHA-256 of the UTF-8 key and a fixed zero 12-byte IV; no IV prefix. */
export async function encryptBuffer(data: Uint8Array, keys: string) {
    // hash the key to get a fixed length key value
    const keyArray = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(keys));

    const key = await window.crypto.subtle.importKey("raw", keyArray, "AES-GCM", false, ["encrypt", "decrypt"]);

    // use web crypto api to encrypt the data
    const result = await window.crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: new Uint8Array(12),
        },
        key,
        asBuffer(data),
    );

    return result;
}

/** Reads `encryptBuffer`'s SHA-256-keyed, zero-IV AES-GCM format; authentication failure rejects. */
export async function decryptBuffer(data: Uint8Array, keys: string) {
    // hash the key to get a fixed length key value
    const keyArray = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(keys));

    const key = await window.crypto.subtle.importKey("raw", keyArray, "AES-GCM", false, ["encrypt", "decrypt"]);

    // use web crypto api to encrypt the data
    const result = await window.crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: new Uint8Array(12),
        },
        key,
        asBuffer(data),
    );

    return result;
}

/** Creates a Svelte writable store initialized with t. */
export function toState<T>(t: T): Writable<T> {
    return writable(t);
}

/** Decodes bytes as UTF-8 with TextDecoder, using Buffer when the TextDecoder binding is falsy. */
export function BufferToText(data: Uint8Array) {
    if (!TextDecoder) {
        return Buffer.from(data).toString("utf-8");
    }
    return new TextDecoder().decode(data);
}

/** Produces the heading format consumed by parseMultilangString; xx is free text, not an ordinary language. */
export function encodeMultilangString(data: { [code: string]: string }) {
    let result = "";
    if (data.xx) {
        result = data.xx;
    }
    for (const key in data) {
        result = `${result}\n# \`${key}\`\n${data[key]}`;
    }
    return result;
}

/** Reads # headings with a backtick-quoted code and newline; free text becomes `xx`, overriding any `xx` section. */
export function parseMultilangString(data: string) {
    let result: { [code: string]: string } = {};
    const regex = /# `(.+?)`\n([\s\S]+?)(?=\n# `|$)/g;
    let m: RegExpExecArray;
    while ((m = regex.exec(data)) !== null) {
        if (m.index === regex.lastIndex) {
            regex.lastIndex++;
        }
        result[m[1]] = m[2];
    }
    result.xx = data.replace(regex, "");
    return result;
}

/** Uses Intl with the code's locale and English fallback; xx yields "Unknown Language", and errors return code. */
export const toLangName = (code: string) => {
    try {
        switch (code) {
            case "xx": {
                //Special case for unknown language
                return "Unknown Language";
            }
            default: {
                return new Intl.DisplayNames([code, "en"], { type: "language" }).of(code);
            }
        }
    } catch (error) {
        return code;
    }
};

/** Uppercases the first UTF-16 code unit and leaves the rest of the string unchanged. */
export const capitalize = (s: string) => {
    return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Reads a Blob through FileReader as bytes; reader errors or a non-ArrayBuffer result reject. */
export function blobToUint8Array(data: Blob) {
    return new Promise<Uint8Array>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) {
                resolve(new Uint8Array(reader.result));
            } else {
                reject(new Error("reader.result is not ArrayBuffer"));
            }
        };
        reader.onerror = () => {
            reject(reader.error);
        };
        reader.readAsArrayBuffer(data);
    });
}

/** Static language-code list for language selection. */
export const languageCodes = [
    "af",
    "ak",
    "am",
    "an",
    "ar",
    "as",
    "ay",
    "az",
    "be",
    "bg",
    "bh",
    "bm",
    "bn",
    "br",
    "bs",
    "ca",
    "co",
    "cs",
    "cy",
    "da",
    "de",
    "dv",
    "ee",
    "el",
    "en",
    "eo",
    "es",
    "et",
    "eu",
    "fa",
    "fi",
    "fo",
    "fr",
    "fy",
    "ga",
    "gd",
    "gl",
    "gn",
    "gu",
    "ha",
    "he",
    "hi",
    "hr",
    "ht",
    "hu",
    "hy",
    "ia",
    "id",
    "ig",
    "is",
    "it",
    "iu",
    "ja",
    "jv",
    "ka",
    "kk",
    "km",
    "kn",
    "ko",
    "ku",
    "ky",
    "la",
    "lb",
    "lg",
    "ln",
    "lo",
    "lt",
    "lv",
    "mg",
    "mi",
    "mk",
    "ml",
    "mn",
    "mr",
    "ms",
    "mt",
    "my",
    "nb",
    "ne",
    "nl",
    "nn",
    "no",
    "ny",
    "oc",
    "om",
    "or",
    "pa",
    "pl",
    "ps",
    "pt",
    "qu",
    "rm",
    "ro",
    "ru",
    "rw",
    "sa",
    "sd",
    "si",
    "sk",
    "sl",
    "sm",
    "sn",
    "so",
    "sq",
    "sr",
    "st",
    "su",
    "sv",
    "sw",
    "ta",
    "te",
    "tg",
    "th",
    "ti",
    "tk",
    "tl",
    "tn",
    "to",
    "tr",
    "ts",
    "tt",
    "tw",
    "ug",
    "uk",
    "ur",
    "uz",
    "vi",
    "wa",
    "wo",
    "xh",
    "yi",
    "yo",
    "zh",
    "zu",
];

/** Sums UTF-16 code units into a deterministic seed; different ids can collide. */
export function uuidtoNumber(uuid: string) {
    let result = 0;
    for (let i = 0; i < uuid.length; i++) {
        result += uuid.charCodeAt(i);
    }
    return result;
}

/** Empty or whitespace-only input counts as terminated. */
export function isLastCharPunctuation(s: string) {
    const lastChar = s.trim().at(-1);
    const punctuation = [
        ".",
        "!",
        "?",
        "。",
        "！",
        "？",
        "…",
        "@",
        "#",
        "$",
        "%",
        "^",
        "&",
        "*",
        "(",
        ")",
        "-",
        "_",
        "+",
        "=",
        "{",
        "}",
        "[",
        "]",
        "|",
        "\\",
        ":",
        ";",
        "<",
        ">",
        ",",
        ".",
        "/",
        "~",
        "`",
        " ",
        "¡",
        "¿",
        "‽",
        "⁉",
        "'",
        '"',
    ];
    if (
        lastChar &&
        !(
            punctuation.indexOf(lastChar) !== -1 ||
            //spacing modifier letters
            (lastChar.charCodeAt(0) >= 0x02b0 && lastChar.charCodeAt(0) <= 0x02ff) ||
            //combining diacritical marks
            (lastChar.charCodeAt(0) >= 0x0300 && lastChar.charCodeAt(0) <= 0x036f) ||
            //hebrew punctuation
            (lastChar.charCodeAt(0) >= 0x0590 && lastChar.charCodeAt(0) <= 0x05cf) ||
            //CJK symbols and punctuation
            (lastChar.charCodeAt(0) >= 0x3000 && lastChar.charCodeAt(0) <= 0x303f)
        )
    ) {
        return false;
    }
    return true;
}

/** Drops trailing code units until isLastCharPunctuation accepts the trimmed suffix, or the string is empty. */
export function trimUntilPunctuation(s: string) {
    let result = s;
    while (result.length > 0 && !isLastCharPunctuation(result)) {
        result = result.slice(0, -1);
    }
    return result;
}

/**
 * Appends the given last path to the provided URL.
 *
 * @param {string} url - The base URL to which the last path will be appended.
 * @param {string} lastPath - The path to be appended to the URL.
 * @returns {string} The modified URL with the last path appended.
 *
 * @example
 * appendLastPath("https://github.com/kwaroran/Risuai","/commits/main")
 * return 'https://github.com/kwaroran/Risuai/commits/main'
 *
 * @example
 * appendLastPath("https://github.com/kwaroran/Risuai/","/commits/main")
 * return 'https://github.com/kwaroran/Risuai/commits/main
 *
 * @example
 * appendLastPath("http://127.0.0.1:7997","embeddings")
 * return 'http://127.0.0.1:7997/embeddings'
 */
export function appendLastPath(url, lastPath) {
    // Remove trailing slash from url if exists
    url = url.replace(/\/$/, "");

    // Remove leading slash from lastPath if exists
    lastPath = lastPath.replace(/^\//, "");

    // Concat the url and lastPath
    return url + "/" + lastPath;
}

/**
 * Converts the text content of a given Node object, including HTML elements, into a plain text sentence.
 *
 * @param {Node} node - The Node object from which the text content will be extracted.
 * @returns {string} The plain text sentence representing the content of the Node object.
 *
 * @example
 * const div = document.createElement('div');
 * div.innerHTML = 'Hello<br>World<del>Deleted</del>';
 * const sentence = getNodetextToSentence(div);
 * console.log(sentence); // Output: "Hello\nWorld~Deleted~"
 */
export function getNodetextToSentence(node: Node): string {
    let result = "";
    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            result += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.nodeName === "BR") {
                result += "\n";
                continue;
            }

            // If a child has a style it's not for a markdown formatting
            const childStyle = (child as HTMLElement)?.style;
            if (childStyle?.cssText !== "") {
                result += getNodetextToSentence(child);
                continue;
            }

            // convert HTML elements to markdown format
            if (child.nodeName === "DEL") {
                result += "~" + getNodetextToSentence(child) + "~";
            } else if (child.nodeName === "STRONG" || child.nodeName === "B") {
                result += "**" + getNodetextToSentence(child) + "**";
            } else if (child.nodeName === "EM" || child.nodeName === "I") {
                result += "*" + getNodetextToSentence(child) + "*";
            } else {
                result += getNodetextToSentence(child);
            }
        }
    }
    return result;
}

/** Recognizes only case-sensitive http://, https://, ccdefault: and the persisted spelling embeded://. */
export const isKnownUri = (uri: string) => {
    return (
        uri.startsWith("http://") ||
        uri.startsWith("https://") ||
        uri.startsWith("ccdefault:") ||
        uri.startsWith("embeded://")
    );
};

/** Nonempty `key=value` lines without trimming; only the first value segment survives extra `=`; [] on failure. */
export function parseKeyValue(template: string) {
    try {
        if (!template) {
            return [];
        }

        const keyValue: [string, string][] = [];

        for (const line of template.split("\n")) {
            const [key, value] = line.split("=");
            if (key && value) {
                keyValue.push([key, value]);
            }
        }

        return keyValue;
    } catch (error) {
        return [];
    }
}

/** Shared sorting options: a 300 ms touch-only delay, .no-sort filter and class-name substring move guard. */
export const sortableOptions = {
    delay: 300, // time in milliseconds to define when the sorting should start
    delayOnTouchOnly: true,
    filter: ".no-sort",
    onMove: (event) => {
        return event.related.className.indexOf("no-sort") === -1;
    },
} as const;

/** Requires a global regexp. Replacers run concurrently; results are inserted in match order. */
export async function replaceAsync(
    string: string,
    regexp: RegExp,
    replacerFunction: (...args: string[]) => Promise<string>,
) {
    const pattern = new RegExp(regexp);
    const replacements = await Promise.all(
        Array.from(string.matchAll(pattern), (match) => replacerFunction(...(match as string[]))),
    );
    let i = 0;
    return string.replace(pattern, () => replacements[i++]);
}

/**
 * Projects supported schema fields recursively; mutates union `type` to its first non-null type,
 * setting `nullable` if the union contained "null".
 */
export function simplifySchema(
    schema: any,
    args: {
        upperType?: boolean;
    } = {},
) {
    if (!schema || typeof schema !== "object") {
        console.error("Schema is not an object", schema);
        return schema;
    }

    if (Array.isArray(schema.type)) {
        if (schema.type.includes("null")) {
            schema.nullable = true;
        }
        schema.type = (schema.type as string[]).filter((v) => v !== "null")[0];
    }

    console.log("schema", schema);
    const result: any = {};

    if (schema.type) {
        result.type = (schema.type as string)?.toLowerCase();
    }
    if (schema.type === "object") {
        result.properties = {};
        for (const key in schema.properties) {
            result.properties[key] = simplifySchema(schema.properties[key], args);
        }
        if (schema.required && schema.required.length > 0) {
            result.required = schema.required;
        }
    }
    if (schema.type === "array") {
        result.items = simplifySchema(schema.items, args);
    }

    if (schema.type === "string" && schema.enum && schema.enum.length > 0) {
        result.enum = schema.enum;
    }

    if (schema.type === "string" && schema.format) {
        result.format = schema.format;
    }

    if (schema.nullable) {
        result.nullable = true;
    }

    if (schema.maxLength !== undefined && schema.maxLength !== null) {
        result.maxLength = schema.maxLength;
    }

    if (schema.minLength !== undefined && schema.minLength !== null) {
        result.minLength = schema.minLength;
    }

    if (schema.minProperties !== undefined && schema.minProperties !== null) {
        result.minProperties = schema.minProperties;
    }

    if (schema.maxProperties !== undefined && schema.maxProperties !== null) {
        result.maxProperties = schema.maxProperties;
    }

    if (schema.description) {
        result.description = schema.description;
    }

    if (schema.anyOf && schema.anyOf.length > 0) {
        console.log("anyOf", schema.anyOf);
        result.anyOf = schema.anyOf.map((v: any) => simplifySchema(v, args));
    }

    return result;
}

/** Prompt instructing image-tag insertion from the current character's CBS display-asset keywords. */
export const prebuiltAssetCommand = `
<Image Tag Instruction>Insert HTML image tags between paragraphs based on context.
Set src as keywords from the list below that matches current character, outfit, situation sentiment and etc.
print as many different images as possible. Use only available keywords.
if there are no matching keywords, try to put clostest matching image src.
try to put at least 1 image per output.
<keywords>{{join::{{chardisplayasset}}::,}}</keywords>
Example: <img src="{{ele::{{chardisplayasset}}::0}}">
<Image Tag Instruction>
`;

/** Removes nonempty <Thoughts> blocks, unwraps one enclosing lowercase json fence and trims whitespace. */
export const jsonOutputTrimmer = (data: string) => {
    data = data.replace(/<Thoughts>(.+?)<\/Thoughts>/gms, "").trim();
    if (data.startsWith("```json") && data.endsWith("```")) {
        data = data.slice(7, -3).trim();
    }
    return data.trim();
};

/** Type assertion for buffer APIs only: returns the same value without copying or converting SharedArrayBuffer. */
export function asBuffer(arr: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer>;
/** ArrayBufferLike overload of the same no-copy type assertion. */
export function asBuffer(arr: ArrayBufferLike): ArrayBuffer;

/** Returns the input unchanged; the ArrayBuffer result type does not convert shared backing storage. */
export function asBuffer(arr: Uint8Array<ArrayBufferLike> | ArrayBufferLike): Uint8Array<ArrayBuffer> | ArrayBuffer {
    if (arr instanceof Uint8Array) {
        return arr as unknown as Uint8Array<ArrayBuffer>;
    } else {
        return arr as unknown as ArrayBuffer;
    }
}

/** Opens IndexedDB `DPoPDB` v1; creates store `name || "DPoPStore"` only on upgrade, not on later opens. */
export function openKeypairStoreDB(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("DPoPDB", 1);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(name || "DPoPStore")) {
                db.createObjectStore(name || "DPoPStore");
            }
        };

        request.onsuccess = (event) => resolve((event.target as IDBOpenDBRequest).result);
        request.onerror = (event) => reject((event.target as IDBOpenDBRequest).error);
    });
}

/**
 * Stores `{ privateKey, publicKey }` CryptoKeys as supplied under key `dpop` in `DPoPDB` v1, store
 * `name || "DPoPStore"`. Preserve the signing private key's non-extractability: `src/ts/storage/serverAuth.ts`
 * generates it with extractable false and uses store `node`; `public/sw.js` reads that same layout.
 */
export async function saveKeypairStore(name: string, keyPair: CryptoKeyPair) {
    const db = await openKeypairStoreDB(name);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(name || "DPoPStore", "readwrite");
        const store = tx.objectStore(name || "DPoPStore");

        const data = {
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
        };

        const request = store.put(data, "dpop");

        request.onsuccess = () => resolve(true);
        request.onerror = (event) => reject((event.target as IDBRequest).error);
    });
}

/** Reads `DPoPDB` v1 / `name || "DPoPStore"` / `dpop` as a CryptoKeyPair, null if absent; IDB errors reject. */
export async function getKeypairStore(name: string): Promise<CryptoKeyPair | null> {
    const db = await openKeypairStoreDB(name);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(name || "DPoPStore", "readonly");
        const store = tx.objectStore(name || "DPoPStore");
        const request = store.get("dpop");

        request.onsuccess = (event) => {
            const result = (event.target as IDBRequest).result;
            if (result) {
                resolve({
                    privateKey: result.privateKey,
                    publicKey: result.publicKey,
                } as CryptoKeyPair);
            } else {
                resolve(null);
            }
        };

        request.onerror = (event) => reject((event.target as IDBRequest).error);
    });
}

/** Unpadded byte encoding used for JWT segments by `src/ts/storage/serverAuth.ts`. */
export function base64url(source: Uint8Array | ArrayBuffer): string {
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
    let encodedSource = btoa(String.fromCharCode.apply(null, [...bytes]))
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    return encodedSource;
}
