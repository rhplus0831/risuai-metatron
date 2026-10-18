import { findCharacter, selectedCharacter } from "./storage/characterStore.svelte";
import { settings } from "./storage/settingsViews.svelte";
import { checkNullish, sleep } from "./util";
import { v4 as uuidv4, v4 } from "uuid";
import { get } from "svelte/store";
import streamSaver from "streamsaver";
import { defaultSdDataFunc, appVer, appSubVer } from "./storage/database.svelte";
import {
    botMakerMode,
    loadedStore,
    LoadingStatusState,
    ReloadGUIPointer,
    bodyIntercepterStore,
    PlaygroundStore,
    OpenRealmStore,
} from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertConfirm, alertError, alertMd, alertNormal, alertNormalWait, alertSelect, waitAlert } from "./alert";
import { hasher } from "./parser/parser.svelte";
import { characterURLImport } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import {
    chatEntry,
    chatList,
    currentChatRef,
    ensureChat,
    selectChat,
    selectedChat,
    type ChatRef,
} from "./storage/chatStore.svelte";
import { selectCharacter, setChatOpen } from "./storage/selection.svelte";
import { listBackups, restoreBackup, ResourceEpochMismatchError } from "./storage/resourceClient";
import {
    readAsset,
    readAssets,
    writeAsset,
    writeAssets,
    type AssetRequestOptions,
    type AssetWriteItem,
} from "./storage/assetClient";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { language } from "src/lang";
import { updateGuisize } from "./gui/guisize";
import { moduleUpdate } from "./process/modules";
import { isLocalNetworkUrl } from "./network/localNetwork";
import { getNodeServerProxyAuth } from "./storage/serverAuth";

interface fetchLog {
    body: string;
    header: string;
    response: string;
    success: boolean;
    date: string;
    url: string;
    responseType?: string;
    chatId?: string;
    status?: number;
}

const FETCH_LOG_MAX_ENTRIES = 20;
const FETCH_LOG_MAX_CHARS = 16 * 1024 * 1024;
const fetchLog: fetchLog[] = [];

/** Keeps the newest entries within both budgets, always retaining the newest entry whole. */
function writeFetchLog(entry: fetchLog): void {
    fetchLog.unshift(entry);
    let retainedChars = 0;
    let length = Math.min(fetchLog.length, FETCH_LOG_MAX_ENTRIES);
    for (let i = 0; i < length; i++) {
        const log = fetchLog[i];
        retainedChars += (log.body?.length ?? 0) + (log.header?.length ?? 0) + (log.response?.length ?? 0);
        if (i > 0 && retainedChars > FETCH_LOG_MAX_CHARS) {
            length = i;
            break;
        }
    }
    // Readers hold this array; trim in place, including a list already over the limits.
    fetchLog.length = length;
}

export async function downloadFile(name: string, dat: Uint8Array | ArrayBuffer | string) {
    if (typeof dat === "string") {
        dat = Buffer.from(dat, "utf-8");
    }
    const data = new Uint8Array(dat);
    const downloadURL = (data: string, fileName: string) => {
        const a = document.createElement("a");
        a.href = data;
        a.download = fileName;
        document.body.appendChild(a);
        a.style.display = "none";
        a.click();
        a.remove();
    };

    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    downloadURL(url, name);

    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 10000);
}

type FileSource = {
    src: Promise<string>;
    url: string | null;
    pinned: boolean;
    holders: number;
    revokeTimer?: ReturnType<typeof setTimeout>;
};

/** One shared load per path, pinned by plain reads or held by previews; failed loads are dropped. */
const fileSources = new Map<string, FileSource>();
/** Let rows shifted by a list edit re-hold their sources before releasing their blobs. */
const FILE_SOURCE_RELEASE_GRACE_MS = 100;

/** How long a service-worker request may take before the read falls back to an object URL. */
const SW_REQUEST_TIMEOUT_MS = 10_000;
const knownSwPaths = new Set<string>();
let swCache: Promise<Cache> | undefined;

/**
 * Gets the source URL of a file: the service worker's URL when the worker holds it (registered once
 * per path), else an object URL of its bytes (also on a page the worker does not control yet, its
 * first load). This plain read pins the source for the page; previews use `holdFileSrc` to release
 * theirs. Concurrent reads share one load. Resolves to `""` when the file cannot be read or is empty.
 *
 * @param {string} loc - The location of the file.
 * @returns {Promise<string>} - A promise that resolves to the source URL of the file.
 */
export function getFileSrc(loc: string): Promise<string> {
    const source = getFileSource(loc);
    source.pinned = true;
    return source.src;
}

/** Holds a preview's source until released; a plain `getFileSrc` read keeps it pinned instead. */
export function holdFileSrc(loc: string): { src: Promise<string>; release(): void } {
    const source = getFileSource(loc);
    source.holders++;
    let released = false;
    return {
        src: source.src,
        release() {
            if (released) return;
            released = true;
            source.holders--;
            scheduleFileSourceRelease(loc, source);
        },
    };
}

function getFileSource(loc: string): FileSource {
    let source = fileSources.get(loc);
    if (!source) {
        source = { src: loadFileSrc(loc), url: null, pinned: false, holders: 0 };
        fileSources.set(loc, source);
        void source.src.then((src) => {
            source.url = src;
            if (src === "" && fileSources.get(loc) === source) {
                fileSources.delete(loc);
            } else {
                // A preview may have released while loading. Keep the entry until now so another
                // hold or a plain read in between reuses (and can pin) the same load.
                scheduleFileSourceRelease(loc, source);
            }
        });
    }
    clearTimeout(source.revokeTimer);
    source.revokeTimer = undefined;
    return source;
}

function scheduleFileSourceRelease(loc: string, source: FileSource): void {
    if (source.pinned || source.holders > 0 || !source.url?.startsWith("blob:") || source.revokeTimer !== undefined) {
        return;
    }
    source.revokeTimer = setTimeout(() => {
        source.revokeTimer = undefined;
        if (!source.pinned && source.holders === 0 && fileSources.get(loc) === source) {
            URL.revokeObjectURL(source.url);
            fileSources.delete(loc);
        }
    }, FILE_SOURCE_RELEASE_GRACE_MS);
}

class MissingFileError extends Error {
    constructor(loc: string) {
        super(`No file at ${loc}`);
    }
}

async function loadFileSrc(loc: string): Promise<string> {
    let bytes: Promise<Uint8Array> | null = null;
    // A missing or empty file is never registered or shown: the read resolves `""` and is tried again.
    const read = () =>
        (bytes ??= (async () => {
            const data = (await readAsset(loc)) as unknown as Uint8Array | null;
            if (!data || data.length === 0) {
                throw new MissingFileError(loc);
            }
            return data;
        })());
    try {
        if (usingSw) {
            try {
                const encoded = Buffer.from(loc, "utf-8").toString("hex");
                const url = "/sw/img/" + encoded;
                if (knownSwPaths.has(loc)) return url;
                let hasCache: boolean;
                try {
                    // The page shares Cache Storage with the worker; a hit needs no worker request.
                    const cache = await (swCache ??= caches.open("risuCache"));
                    hasCache = !!(await cache.match(url));
                } catch {
                    // Cache Storage can be unavailable or denied even with a controlling worker.
                    swCache = undefined;
                    const check = await fetch("/sw/check/" + encoded, {
                        signal: AbortSignal.timeout(SW_REQUEST_TIMEOUT_MS),
                    });
                    hasCache = (await check.json()).able;
                }
                if (!hasCache) {
                    const registered = await fetch("/sw/register/" + encoded, {
                        method: "POST",
                        body: (await read()) as any,
                        signal: AbortSignal.timeout(SW_REQUEST_TIMEOUT_MS),
                    });
                    if (!registered.ok) {
                        throw new Error(`The service worker did not register ${loc}`);
                    }
                    await sleep(10);
                }
                knownSwPaths.add(loc);
                return url;
            } catch (error) {
                if (error instanceof MissingFileError) {
                    throw error;
                }
                // The worker is not there (or does not control this page yet): an object URL.
                console.warn(error);
            }
        }
        return URL.createObjectURL(new Blob([(await read()) as Uint8Array<ArrayBuffer>], { type: "image/png" }));
    } catch (error) {
        console.error(error);
        return "";
    }
}

/**
 * Reads an image file and returns its data.
 *
 * @param {string} data - The path to the image file.
 * @returns {Promise<Uint8Array>} - A promise that resolves to the data of the image file.
 */
export async function readImage(data: string) {
    return (await readAsset(data)) as unknown as Uint8Array;
}

/**
 * Saves an asset file with the given data, custom ID, and file name.
 *
 * @param {Uint8Array} data - The data of the asset file.
 * @param {string} [customId=''] - The custom ID for the asset file.
 * @param {string} [fileName=''] - The name of the asset file.
 * @param {AssetRequestOptions} [options] - `signal` aborts the write (and its retries, `writeAsset`).
 * @returns {Promise<string>} - A promise that resolves to the path of the saved asset file.
 */
export async function saveAsset(
    data: Uint8Array,
    customId: string = "",
    fileName: string = "",
    options: AssetRequestOptions = {},
) {
    const form = await assetKey(data, customId, fileName);
    await writeAsset(form, data, options);
    return form;
}

/**
 * The key {@link saveAsset} stores `data` under: `assets/<customId or the bytes' SHA-256 hex (a uuid
 * when hashing fails)>.<fileName's extension, default png>`.
 */
export async function assetKey(data: Uint8Array, customId: string = "", fileName: string = ""): Promise<string> {
    let id = "";
    if (customId !== "") {
        id = customId;
    } else {
        try {
            id = await hasher(data);
        } catch (error) {
            id = uuidv4();
        }
    }
    let fileExtension: string = "png";
    if (fileName && fileName.split(".").length > 0) {
        fileExtension = fileName.split(".").pop();
    }
    return `assets/${id}.${fileExtension}`;
}

/** Writes each item under its key with the batch route (`writeAssets`: one request per batch, retried). */
export async function saveAssetBatch(
    items: readonly AssetWriteItem[],
    options: AssetRequestOptions = {},
): Promise<void> {
    await writeAssets(items, options);
}

/**
 * Loads an asset file with the given ID.
 *
 * @param {string} id - The ID of the asset file to load.
 * @returns {Promise<Uint8Array>} - A promise that resolves to the data of the loaded asset file.
 */
export async function loadAsset(id: string) {
    return (await readAsset(id)) as unknown as Uint8Array;
}

/** Reads assets in key order, preserving duplicates and null records for missing or empty files. */
export async function loadAssets(
    keys: readonly string[],
    options: { signal?: AbortSignal } = {},
): Promise<(Uint8Array | null)[]> {
    return readAssets(keys, options);
}

export { saving } from "./storage/resourceSync.svelte";

let usingSw = false;

export function setUsingSw(value: boolean) {
    usingSw = value;
}

/**
 * Retrieves fetch data for a given chat ID.
 *
 * @param {string} id - The chat ID to search for in the fetch log.
 * @returns {fetchLog | null} - The fetch log entry if found, otherwise null.
 */
export function getFetchData(id: string) {
    for (const log of fetchLog) {
        if (log.chatId === id) {
            return log;
        }
    }
    return null;
}

const knownHostes = ["localhost", "127.0.0.1", "0.0.0.0"];

function buildTimeoutSignal(originalSignal?: AbortSignal, timeoutMs?: number) {
    if (!timeoutMs || timeoutMs <= 0) {
        return {
            signal: originalSignal,
            cleanup: () => {
                /* no-op */
            },
        };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (originalSignal) {
        if (originalSignal.aborted) {
            controller.abort();
        } else {
            originalSignal.addEventListener("abort", onAbort, { once: true });
        }
    }

    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutId);
            originalSignal?.removeEventListener("abort", onAbort);
        },
    };
}

/**
 * Interface representing the arguments for the global fetch function.
 *
 * @interface GlobalFetchArgs
 * @property {boolean} [plainFetchForce] - Whether to force plain fetch.
 * @property {any} [body] - The body of the request.
 * @property {{ [key: string]: string }} [headers] - The headers of the request.
 * @property {boolean} [rawResponse] - Whether to return the raw response.
 * @property {'POST' | 'GET'} [method] - The HTTP method to use.
 * @property {AbortSignal} [abortSignal] - The abort signal to cancel the request.
 * @property {boolean} [useRisuToken] - Whether to use the Risu token.
 * @property {string} [chatId] - The chat ID associated with the request.
 */
export interface GlobalFetchArgs {
    plainFetchForce?: boolean;
    plainFetchDeforce?: boolean;
    body?: any;
    headers?: { [key: string]: string };
    rawResponse?: boolean;
    method?: "POST" | "GET";
    abortSignal?: AbortSignal;
    useRisuToken?: boolean;
    chatId?: string;
    interceptor?: string;
    requestTimeoutMs?: number;
    networkRoute?: "auto" | "local_network";
}

/**
 * Interface representing the result of the global fetch function.
 *
 * @interface GlobalFetchResult
 * @property {boolean} ok - Whether the request was successful.
 * @property {any} data - The data returned from the request.
 * @property {{ [key: string]: string }} headers - The headers returned from the request.
 */
interface GlobalFetchResult {
    ok: boolean;
    data: any;
    headers: { [key: string]: string };
    status: number;
}

/**
 * Adds a fetch log entry.
 *
 * @param {Object} arg - The arguments for the fetch log entry.
 * @param {any} arg.body - The body of the request.
 * @param {{ [key: string]: string }} [arg.headers] - The headers of the request.
 * @param {any} arg.response - The response from the request.
 * @param {boolean} arg.success - Whether the request was successful.
 * @param {string} arg.url - The URL of the request.
 * @param {string} [arg.resType] - The response type.
 * @param {string} [arg.chatId] - The chat ID associated with the request.
 * @returns {number} - The index of the added fetch log entry.
 */
export function addFetchLog(arg: {
    body: any;
    headers?: { [key: string]: string };
    response: any;
    success: boolean;
    url: string;
    resType?: string;
    chatId?: string;
    status?: number;
}): number {
    writeFetchLog({
        body: typeof arg.body === "string" ? arg.body : JSON.stringify(arg.body, null, 2),
        header: JSON.stringify(arg.headers ?? {}, null, 2),
        response: typeof arg.response === "string" ? arg.response : JSON.stringify(arg.response, null, 2),
        responseType: arg.resType ?? "json",
        success: arg.success,
        date: new Date().toLocaleTimeString(),
        url: arg.url,
        chatId: arg.chatId,
        status: arg.status,
    });
    return 0;
}

/**
 * Adds an entry the server built (`POST /api/llm/request`'s `log` events: the server's fetches, in
 * the shape `addFetchLog` builds, with the credentials redacted).
 */
export function appendFetchLog(entry: fetchLog) {
    writeFetchLog(entry);
}

/**
 * Performs a global fetch request.
 *
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} [arg={}] - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
export async function globalFetch(url: string, arg: GlobalFetchArgs = {}): Promise<GlobalFetchResult> {
    try {
        if (arg.abortSignal?.aborted) {
            return { ok: false, data: "aborted", headers: {}, status: 400 };
        }

        const urlHost = new URL(url).hostname;
        const useLocalNetworkRoute = arg.networkRoute === "local_network" && isLocalNetworkUrl(url);
        const forcePlainFetch =
            (knownHostes.includes(urlHost) || settings.providers.usePlainFetch || arg.plainFetchForce) &&
            !arg.plainFetchDeforce &&
            !useLocalNetworkRoute;

        if (arg.interceptor) {
            for (const interceptor of bodyIntercepterStore) {
                try {
                    arg.body = (await interceptor.callback(arg.body, arg.interceptor)) || arg.body;
                } catch (e) {
                    console.error(e);
                }
            }
        }

        const timeoutSignal = buildTimeoutSignal(arg.abortSignal, arg.requestTimeoutMs);
        const requestArg =
            timeoutSignal.signal === arg.abortSignal ? arg : { ...arg, abortSignal: timeoutSignal.signal };

        try {
            if (useLocalNetworkRoute) {
                return await fetchWithProxy(url, requestArg);
            }
            if (forcePlainFetch) {
                return await fetchWithPlainFetch(url, requestArg);
            }
            //userScriptFetch is provided by userscript
            if (window.userScriptFetch) {
                return await fetchWithUSFetch(url, requestArg);
            }
            return await fetchWithProxy(url, requestArg);
        } finally {
            timeoutSignal.cleanup();
        }
    } catch (error) {
        console.error(error);
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Adds a fetch log entry in the global fetch log.
 *
 * @param {any} response - The response data.
 * @param {boolean} success - Indicates if the fetch was successful.
 * @param {string} url - The URL of the fetch request.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 */
function addFetchLogInGlobalFetch(response: any, success: boolean, url: string, arg: GlobalFetchArgs, status?: number) {
    try {
        writeFetchLog({
            body: JSON.stringify(arg.body, null, 2),
            header: JSON.stringify(arg.headers ?? {}, null, 2),
            response: JSON.stringify(response, null, 2),
            success: success,
            date: new Date().toLocaleTimeString(),
            url: url,
            chatId: arg.chatId,
            status: status,
        });
    } catch {
        writeFetchLog({
            body: JSON.stringify(arg.body, null, 2),
            header: JSON.stringify(arg.headers ?? {}, null, 2),
            response: `${response}`,
            success: success,
            date: new Date().toLocaleTimeString(),
            url: url,
            chatId: arg.chatId,
            status: status,
        });
    }
}

/**
 * Performs a fetch request using plain fetch.
 *
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithPlainFetch(url: string, arg: GlobalFetchArgs): Promise<GlobalFetchResult> {
    try {
        const headers = { "Content-Type": "application/json", ...arg.headers };
        const response = await fetch(new URL(url), {
            body: JSON.stringify(arg.body),
            headers,
            method: arg.method ?? "POST",
            signal: arg.abortSignal,
        });
        const data = arg.rawResponse ? new Uint8Array(await response.arrayBuffer()) : await response.json();
        const ok = response.ok && response.status >= 200 && response.status < 300;
        addFetchLogInGlobalFetch(data, ok, url, arg, response.status);
        return { ok, data, headers: Object.fromEntries(response.headers), status: response.status };
    } catch (error) {
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Performs a fetch request using userscript provided fetch.
 *
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithUSFetch(url: string, arg: GlobalFetchArgs): Promise<GlobalFetchResult> {
    try {
        const headers = { "Content-Type": "application/json", ...arg.headers };
        const response = await userScriptFetch(url, {
            body: JSON.stringify(arg.body),
            headers,
            method: arg.method ?? "POST",
            signal: arg.abortSignal,
        });
        const data = arg.rawResponse ? new Uint8Array(await response.arrayBuffer()) : await response.json();
        const ok = response.ok && response.status >= 200 && response.status < 300;
        addFetchLogInGlobalFetch(data, ok, url, arg, response.status);
        return { ok, data, headers: Object.fromEntries(response.headers), status: response.status };
    } catch (error) {
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Performs a fetch request using a proxy.
 *
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithProxy(url: string, arg: GlobalFetchArgs): Promise<GlobalFetchResult> {
    try {
        arg.headers ??= {};
        arg.headers["Content-Type"] ??=
            arg.body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json";
        const nodeProxyAuth = await getNodeServerProxyAuth();
        const headers = {
            "risu-header": encodeURIComponent(JSON.stringify(arg.headers)),
            "risu-url": encodeURIComponent(url),
            "Content-Type":
                arg.body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json",
            ...(arg.useRisuToken && { "x-risu-tk": "use" }),
            ...(arg.requestTimeoutMs && {
                "risu-timeout-ms": Math.max(1, Math.floor(arg.requestTimeoutMs)).toString(),
            }),
            ...(nodeProxyAuth && { "risu-auth": nodeProxyAuth }),
        };

        const body = arg.body instanceof URLSearchParams ? arg.body.toString() : JSON.stringify(arg.body);

        const response = await fetch("/proxy2", {
            body,
            headers,
            method: arg.method ?? "POST",
            signal: arg.abortSignal,
        });
        const isSuccess = response.ok && response.status >= 200 && response.status < 300;

        if (arg.rawResponse) {
            const data = new Uint8Array(await response.arrayBuffer());
            addFetchLogInGlobalFetch("Uint8Array Response", isSuccess, url, arg, response.status);
            return { ok: isSuccess, data, headers: Object.fromEntries(response.headers), status: response.status };
        }

        const text = await response.text();
        try {
            const data = JSON.parse(text);
            addFetchLogInGlobalFetch(data, isSuccess, url, arg, response.status);
            return { ok: isSuccess, data, headers: Object.fromEntries(response.headers), status: response.status };
        } catch (error) {
            const errorMsg = text.startsWith("<!DOCTYPE")
                ? "Responded HTML. Is your URL, API key, and password correct?"
                : text;
            addFetchLogInGlobalFetch(text, false, url, arg, response.status);
            return {
                ok: false,
                data: errorMsg,
                headers: Object.fromEntries(response.headers),
                status: response.status,
            };
        }
    } catch (error) {
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Regular expression to match backslashes.
 *
 * @constant {RegExp}
 */
const re = /\\/g;

/**
 * Gets the basename of a given path.
 *
 * @param {string} data - The path to get the basename from.
 * @returns {string} - The basename of the path.
 */
export function getBasename(data: string) {
    const splited = data.replace(re, "/").split("/");
    const lasts = splited[splited.length - 1];
    return lasts;
}

/** The `characterOrder` mutation; it lives in the storage layer (`storage/characterOrder.ts`). */
export { checkCharOrder } from "./storage/characterOrder";

/**
 * Retrieves the fetch logs array.
 *
 * @returns {fetchLog[]} The fetch logs array.
 */
export function getFetchLogs() {
    return fetchLog;
}

/**
 * Opens a URL in the appropriate environment.
 *
 * @param {string} url - The URL to open.
 */
export function openURL(url: string) {
    window.open(url, "_blank");
}

/**
 * Converts FormData to a URL-encoded string.
 *
 * @param {FormData} formData - The FormData to convert.
 * @returns {string} The URL-encoded string.
 */
function formDataToString(formData: FormData): string {
    const params: string[] = [];

    for (const [name, value] of formData.entries()) {
        params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value.toString())}`);
    }

    return params.join("&");
}

/**
 * Class representing a local writer.
 */
export class LocalWriter {
    writer: WritableStreamDefaultWriter;

    /**
     * Initializes the writer.
     *
     * @param {string} [name='Binary'] - The name of the file.
     * @param {string[]} [ext=['bin']] - The file extensions.
     * @returns {Promise<boolean>} - A promise that resolves to a boolean indicating success.
     */
    async init(name = "Binary", ext = ["bin"]): Promise<boolean> {
        const writableStream = streamSaver.createWriteStream(name + "." + ext[0]);
        this.writer = writableStream.getWriter();
        return true;
    }

    /**
     * Writes backup data to the file.
     *
     * @param {string} name - The name of the backup.
     * @param {Uint8Array} data - The data to write.
     */
    async writeBackup(name: string, data: Uint8Array): Promise<void> {
        const encodedName = new TextEncoder().encode(getBasename(name));
        const nameLength = new Uint32Array([encodedName.byteLength]);
        await this.writer.write(new Uint8Array(nameLength.buffer));
        await this.writer.write(encodedName);
        const dataLength = new Uint32Array([data.byteLength]);
        await this.writer.write(new Uint8Array(dataLength.buffer));
        await this.writer.write(data);
    }

    /**
     * Writes data to the file.
     *
     * @param {Uint8Array} data - The data to write.
     */
    async write(data: Uint8Array): Promise<void> {
        await this.writer.write(data);
    }

    /**
     * Closes the writer.
     */
    async close(): Promise<void> {
        await this.writer.close();
    }

    /** Drops a partial download. Cleanup is safe before init and after close or another abort. */
    async abort(reason?: unknown): Promise<void> {
        try {
            await this.writer?.abort(reason);
        } catch {
            // An already closed or errored stream needs no further cleanup.
        }
    }
}

/**
 * Class representing a virtual writer.
 */
export class VirtualWriter {
    buf = new AppendableBuffer();

    /**
     * Writes data to the buffer.
     *
     * @param {Uint8Array} data - The data to write.
     */
    write(data: Uint8Array): void {
        this.buf.append(data);
    }

    /**
     * Closes the writer. (No operation for VirtualWriter)
     */
    close(): void {
        // do nothing
    }

    abort(): void {
        // No external output to cancel.
    }
}

/**
 * A class to manage a buffer that can be appended to and deappended from.
 */
export class AppendableBuffer {
    deapended: number = 0;
    #buffer: Uint8Array;
    #byteLength: number = 0;

    /**
     * Creates an instance of AppendableBuffer.
     */
    constructor() {
        this.#buffer = new Uint8Array(128);
    }

    get buffer(): Uint8Array {
        return this.#buffer.slice(0, this.#byteLength);
    }

    /**
     * Appends data to the buffer.
     * @param {Uint8Array} data - The data to append.
     */
    append(data: Uint8Array) {
        // New way (faster)
        const requiredLength = this.#byteLength + data.length;
        if (this.#buffer.byteLength < requiredLength) {
            let newLength = this.#buffer.byteLength * 2;
            while (newLength < requiredLength) {
                newLength *= 2;
            }
            const newBuffer = new Uint8Array(newLength);
            newBuffer.set(this.#buffer);
            this.#buffer = newBuffer;
        }
        this.#buffer.set(data, this.#byteLength);
        this.#byteLength += data.length;
    }

    /**
     * Deappends a specified length from the buffer.
     * @param {number} length - The length to deappend.
     */
    deappend(length: number) {
        this.#buffer = this.#buffer.slice(length);
        this.deapended += length;
        this.#byteLength -= length;
    }

    /**
     * Slices the buffer from start to end.
     * @param {number} start - The start index.
     * @param {number} end - The end index.
     * @returns {Uint8Array} - The sliced buffer.
     */
    slice(start: number, end: number) {
        // Slices the backing array directly (the `buffer` getter would copy the whole window first),
        // resolving the indices against the used length as `buffer.slice` would, so the unused tail
        // is never included.
        const length = this.#byteLength;
        const resolve = (index: number) => {
            const i = Math.trunc(index) || 0;
            return i < 0 ? Math.max(length + i, 0) : Math.min(i, length);
        };
        return this.#buffer.slice(resolve(start - this.deapended), resolve(end - this.deapended));
    }

    /**
     * Gets the total length of the buffer including deappended length.
     * @returns {number} - The total length.
     */
    length() {
        return this.#byteLength + this.deapended;
    }

    /**
     * Clears the buffer.
     */
    clear() {
        this.#buffer = new Uint8Array(128);
        this.#byteLength = 0;
        this.deapended = 0;
    }
}

/**
 * Fetches data from a given URL using native fetch or through a proxy.
 * @param {string} url - The URL to fetch data from.
 * @param {Object} arg - The arguments for the fetch request.
 * @param {string} arg.body - The body of the request.
 * @param {Object} [arg.headers] - The headers of the request.
 * @param {string} [arg.method="POST"] - The HTTP method of the request.
 * @param {AbortSignal} [arg.signal] - The signal to abort the request.
 * @param {boolean} [arg.useRisuTk] - Whether to use Risu token.
 * @param {string} [arg.chatId] - The chat ID associated with the request.
 * @returns {Promise<Object>} - A promise that resolves to an object containing the response body, headers, and status.
 * @returns {ReadableStream<Uint8Array>} body - The response body as a readable stream.
 * @returns {Headers} headers - The response headers.
 * @returns {number} status - The response status code.
 * @throws {Error} - Throws an error if the request is aborted or if there is an error in the response.
 */
export async function fetchNative(
    url: string,
    arg: {
        body?: string | Uint8Array | ArrayBuffer;
        headers?: { [key: string]: string };
        method?: string;
        signal?: AbortSignal;
        useRisuTk?: boolean;
        chatId?: string;
        interceptor?: string;
        logFetch?: boolean;
        requestTimeoutMs?: number;
        networkRoute?: "auto" | "local_network";
    } = {},
): Promise<Response> {
    const useInterceptor = !!arg?.interceptor;

    arg.method = arg.method ?? "POST";

    let headers = arg.headers ?? {};
    let realBody: Uint8Array;

    if (arg.method === "GET" || arg.method === "HEAD" || arg.body === undefined) {
        realBody = undefined;
    } else if (typeof arg.body === "string") {
        let body: string = arg.body;
        if (useInterceptor) {
            for (const interceptor of bodyIntercepterStore) {
                try {
                    body = (await interceptor.callback(body, arg.interceptor)) || body;
                } catch (e) {
                    console.error(e);
                }
            }
        }
        realBody = new TextEncoder().encode(body);
    } else if (arg.body instanceof Uint8Array) {
        realBody = arg.body;
    } else if (arg.body instanceof ArrayBuffer) {
        realBody = new Uint8Array(arg.body);
    } else {
        throw new Error("Invalid body type");
    }

    const useLocalNetworkRoute = arg.networkRoute === "local_network" && isLocalNetworkUrl(url);
    const throughProxy = useLocalNetworkRoute;
    const timeoutSignal = buildTimeoutSignal(arg.signal, arg.requestTimeoutMs);
    const requestSignal = timeoutSignal.signal;
    const shouldLogFetch = arg.logFetch ?? true;
    if (shouldLogFetch) {
        addFetchLog({
            body: new TextDecoder().decode(realBody),
            headers: arg.headers,
            response: "Streamed Fetch",
            success: true,
            url: url,
            resType: "stream",
            chatId: arg.chatId,
        });
    }
    try {
        if (window.userScriptFetch && !throughProxy) {
            return await window.userScriptFetch(url, {
                body: realBody as any,
                headers: headers,
                method: arg.method,
                signal: requestSignal,
            });
        } else if (throughProxy) {
            const nodeProxyAuth = await getNodeServerProxyAuth();

            const r = await fetch("/proxy2", {
                body: realBody as any,
                headers: arg.useRisuTk
                    ? {
                          "risu-header": encodeURIComponent(JSON.stringify(headers)),
                          "risu-url": encodeURIComponent(url),
                          "Content-Type": "application/json",
                          "x-risu-tk": "use",
                          ...(arg.requestTimeoutMs && {
                              "risu-timeout-ms": Math.max(1, Math.floor(arg.requestTimeoutMs)).toString(),
                          }),
                          ...(nodeProxyAuth ? { "risu-auth": nodeProxyAuth } : {}),
                      }
                    : {
                          "risu-header": encodeURIComponent(JSON.stringify(headers)),
                          "risu-url": encodeURIComponent(url),
                          "Content-Type": "application/json",
                          ...(arg.requestTimeoutMs && {
                              "risu-timeout-ms": Math.max(1, Math.floor(arg.requestTimeoutMs)).toString(),
                          }),
                          ...(nodeProxyAuth ? { "risu-auth": nodeProxyAuth } : {}),
                      },
                method: arg.method,
                signal: requestSignal,
            });

            return new Response(r.body, {
                headers: r.headers,
                status: r.status,
            });
        } else {
            return await fetch(url, {
                body: realBody as any,
                headers: headers,
                method: arg.method,
                signal: requestSignal,
            });
        }
    } finally {
        timeoutSignal.cleanup();
    }
}

/**
 * Toggles the fullscreen mode of the document.
 * If the document is currently in fullscreen mode, it exits fullscreen.
 * If the document is not in fullscreen mode, it requests fullscreen with navigation UI hidden.
 */
export function toggleFullscreen() {
    const fullscreenElement = document.fullscreenElement;
    fullscreenElement
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen({
              navigationUI: "hide",
          });
}

/**
 * Removes non-Latin characters from a string, replaces multiple spaces with a single space, and trims the string.
 *
 * @param {string} data - The input string to be processed.
 * @returns {string} The processed string with non-Latin characters removed, multiple spaces replaced by a single space, and trimmed.
 */
export function trimNonLatin(data: string) {
    return data
        .replace(/[^\x00-\x7F]/g, "")
        .replace(/ +/g, " ")
        .trim();
}

/**
 * A class that provides a blank writer implementation.
 *
 * This class is used to provide a no-op implementation of a writer, making it compatible with other writer interfaces.
 */
export class BlankWriter {
    constructor() {}

    /**
     * Initializes the writer.
     *
     * This method does nothing and is provided for compatibility with other writer interfaces.
     */
    async init() {
        //do nothing, just to make compatible with other writer
    }

    /**
     * Writes data to the writer.
     *
     * This method does nothing and is provided for compatibility with other writer interfaces.
     *
     * @param {string} key - The key associated with the data.
     * @param {Uint8Array|string} data - The data to be written.
     */
    async write(key: string, data: Uint8Array | string) {
        //do nothing, just to make compatible with other writer
    }

    /**
     * Ends the writing process.
     *
     * This method does nothing and is provided for compatibility with other writer interfaces.
     */
    async end() {
        //do nothing, just to make compatible with other writer
    }
}

/**
 * Lets the user pick one of the server's resource snapshots (taken every 10 minutes while data
 * changes, 20 kept) and restores it; the app then reloads.
 */
export async function loadInternalBackup() {
    let backups: Awaited<ReturnType<typeof listBackups>>;
    try {
        backups = await listBackups();
    } catch (error) {
        alertError(error instanceof Error ? error.message : String(error));
        return;
    }

    const selectOptions = ["Cancel", ...backups.map((backup) => new Date(backup.createdAt).toLocaleString())];

    const alertResult = parseInt(await alertSelect(selectOptions)) - 1;

    if (!(alertResult >= 0 && alertResult < backups.length)) {
        return;
    }

    try {
        await restoreBackup(backups[alertResult].id);
    } catch (error) {
        if (!(error instanceof ResourceEpochMismatchError)) {
            alertError(error instanceof Error ? error.message : String(error));
            return;
        }
    }
    await alertNormalWait("Loaded backup");
    location.reload();
}

/**
 * A debugging class for performance measurement.
 */

export class PerformanceDebugger {
    kv: { [key: string]: number[] } = {};
    startTime: number;
    endTime: number;

    /**
     * Starts the timing measurement.
     */
    start() {
        this.startTime = performance.now();
    }

    /**
     * Ends the timing measurement and records the time difference.
     *
     * @param {string} key - The key to associate with the recorded time.
     */
    endAndRecord(key: string) {
        this.endTime = performance.now();
        if (!this.kv[key]) {
            this.kv[key] = [];
        }
        this.kv[key].push(this.endTime - this.startTime);
    }

    /**
     * Ends the timing measurement, records the time difference, and starts a new timing measurement.
     *
     * @param {string} key - The key to associate with the recorded time.
     */
    endAndRecordAndStart(key: string) {
        this.endAndRecord(key);
        this.start();
    }

    /**
     * Logs the average time for each key to the console.
     */
    log() {
        let table: { [key: string]: number } = {};

        for (const key in this.kv) {
            table[key] = this.kv[key].reduce((a, b) => a + b, 0) / this.kv[key].length;
        }

        console.table(table);
    }

    combine(other: PerformanceDebugger) {
        for (const key in other.kv) {
            if (!this.kv[key]) {
                this.kv[key] = [];
            }
            this.kv[key].push(...other.kv[key]);
        }
    }
}

export function getLanguageCodes() {
    let languageCodes: {
        code: string;
        name: string;
    }[] = [];

    for (let i = 0x41; i <= 0x5a; i++) {
        for (let j = 0x41; j <= 0x5a; j++) {
            languageCodes.push({
                code: String.fromCharCode(i) + String.fromCharCode(j),
                name: "",
            });
        }
    }

    languageCodes = languageCodes
        .map((v) => {
            return {
                code: v.code.toLocaleLowerCase(),
                name: new Intl.DisplayNames([settings.ui.language === "cn" ? "zh" : settings.ui.language], {
                    type: "language",
                    fallback: "none",
                }).of(v.code),
            };
        })
        .filter((a) => {
            return a.name;
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    return languageCodes;
}

export function getVersionString(): string {
    let versionString = appVer;
    if (appSubVer) {
        versionString += "-" + appSubVer;
    }
    if (import.meta.env.VITE_RISU_NIGHTLY_BUILD === "TRUE") {
        versionString = "Nightly Build " + import.meta.env.VITE_RISU_BUILD_TIME;
    }
    return versionString;
}

export function toGetter<T extends object>(
    getterFn: () => T,
    args?: {
        //blocks this.children from being accessed
        restrictChildren: string[];
    },
): T {
    const dummyTarget = () => {};

    return new Proxy(dummyTarget, {
        get(target, prop, receiver) {
            const realInstance = getterFn();

            if (args?.restrictChildren && args.restrictChildren.includes(prop as string)) {
                throw new Error(`Access to property '${String(prop)}' is restricted`);
            }

            if (realInstance === null || realInstance === undefined) {
                return (realInstance as any)[prop];
            }

            const value = Reflect.get(realInstance as object, prop);

            if (typeof value === "function") {
                return value.bind(realInstance);
            }

            return value;
        },

        set(target, prop, value, receiver) {
            if (args?.restrictChildren && args.restrictChildren.includes(prop as string)) {
                throw new Error(`Access to property '${String(prop)}' is restricted`);
            }
            const realInstance = getterFn();
            return Reflect.set(realInstance as object, prop, value, receiver);
        },

        has(target, prop) {
            const realInstance = getterFn();
            return Reflect.has(realInstance as object, prop);
        },

        ownKeys(target) {
            const realInstance = getterFn();
            return Reflect.ownKeys(realInstance as object);
        },

        construct(target, argArray, newTarget) {
            const realInstance = getterFn() as any;
            return new realInstance(...argArray);
        },

        deleteProperty(target, prop) {
            const realInstance = getterFn();
            return Reflect.deleteProperty(realInstance as object, prop);
        },

        getPrototypeOf() {
            const realInstance = getterFn();
            return Reflect.getPrototypeOf(realInstance as object);
        },
    }) as unknown as T;
}

const countriesWithAiLaw = new Set<string>([
    // EU
    // AI Act
    // https://artificialintelligenceact.eu/

    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "EL",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",

    //China
    //Measures for Labeling of AI-Generated Synthetic Content
    // 关于印发《人工智能生成合成内容标识办法》的通知
    // https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
    "CN",

    //Although CN Law doesn't apply, just in case
    "HK",
    "MO",

    //TW isn't under mainland china jurisdiction
    //de facto, de jure in TW law, unlike HK and MO,
    //So we don't include it for now
    //"TW",

    // Republic of Korea
    // AI Basic Act
    // 인공지능 발전과 신뢰 기반 조성 등에 관한 기본법
    // https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5%20%EB%B0%9C%EC%A0%84%EA%B3%BC%20%EC%8B%A0%EB%A2%B0%20%EA%B8%B0%EB%B0%98%20%EC%A1%B0%EC%84%B1%20%EB%93%B1%EC%97%90%20%EA%B4%80%ED%95%9C%20%EA%B8%B0%EB%B3%B8%EB%B2%95/(20676,20250121)
    "KR",

    // Vietnam
    // Digital Tech Law
    // Luật Công nghệ số
    "VN",
]);

export function aiLawApplies(): boolean {
    //TODO: implement actual logic
    //lets now assume it always applies
    //so we don't have legal issues later

    return true;
}

export function aiWatermarkingLawApplies(): boolean {
    //TODO: implement actual logic
    //lets now assume it is false for now,
    //becuase very few countries have it for now
    return false;
}

export const chatFoldedState = $state<{
    data: null | {
        targetCharacterId: string;
        targetChatId: string;
        targetMessageId: string;
    };
}>({
    data: null,
});

//Since its exported, we cannot use $derived here
export let chatFoldedStateMessageIndex = $state({
    index: -1,
});

$effect.root(() => {
    $effect(() => {
        if (!chatFoldedState.data) {
            return;
        }
        const ref = currentChatRef();
        if (chatFoldedState.data.targetCharacterId !== ref?.chaId) {
            chatFoldedState.data = null;
        } else if (chatFoldedState.data.targetChatId !== ref.chatId) {
            chatFoldedState.data = null;
        }
    });

    $effect(() => {
        if (chatFoldedState.data === null) {
            chatFoldedStateMessageIndex.index = -1;
            return;
        }
        const chat = selectedChat();
        const messageIndex = (chat?.message ?? []).findIndex((v) => {
            return chatFoldedState.data?.targetMessageId === v.chatId;
        });
        if (messageIndex === -1) {
            console.warn("Target message for folding id" + chatFoldedState.data?.targetMessageId + " not found");
            chatFoldedStateMessageIndex.index = -1;
            return;
        }
        chatFoldedStateMessageIndex.index = messageIndex;
    });
});

export function foldChatToMessage(targetMessageIdOrIndex: string | number) {
    let targetMessageId = "";
    if (typeof targetMessageIdOrIndex === "number") {
        const message = selectedChat()?.message[targetMessageIdOrIndex];
        targetMessageId = message?.chatId;
    } else {
        targetMessageId = targetMessageIdOrIndex;
    }
    const ref = currentChatRef();
    if (!ref) {
        return;
    }
    chatFoldedState.data = {
        targetCharacterId: ref.chaId,
        targetChatId: ref.chatId,
        targetMessageId: targetMessageId,
    };
}

/** Selects a chat of the selected character by id or by its index in the list (per tab), and opens it. */
export function changeChatTo(IdOrIndex: string | number) {
    const character = selectedCharacter();
    if (!character) {
        return;
    }
    selectChat(character.chaId, IdOrIndex);
    setChatOpen(true);
    ReloadGUIPointer.set(Math.random());
}

/** Opens a pin by id, selecting its chat before its character so only the target chat is loaded. */
export function openPinnedChat(ref: ChatRef, reseter?: () => void) {
    if (!findCharacter(ref.chaId) || !chatEntry(ref)) {
        return;
    }
    reseter?.();
    ensureChat(ref.chaId);
    selectChat(ref.chaId, ref.chatId);
    PlaygroundStore.set(ref.chaId === "§playground" ? 2 : 0);
    OpenRealmStore.set(false);
    selectCharacter(ref.chaId);
    setChatOpen(true);
    ReloadGUIPointer.set(Math.random());
}

/** A name for a copy or branch of a chat, unique among the chats of `chaId` (default: the selected character). */
export function createChatCopyName(
    originalName: string,
    type: "Copy" | "Branch",
    chaId: string = selectedCharacter()?.chaId ?? "",
): string {
    let name = originalName.replaceAll(/\(((Copy|Branch)( \d+)?)\)$/g, "").trim();
    let copyIndex = 1;
    let newName = `${name} (${type})`;
    const names = new Set(chatList(chaId).map((entry) => entry.name));
    while (names.has(newName)) {
        copyIndex++;
        newName = `${name} (${type} ${copyIndex})`;
    }
    return newName;
}
