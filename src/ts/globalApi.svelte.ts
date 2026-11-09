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
import { alertConfirm, alertError, alertMd, alertNormal, waitAlert } from "./alert";
import { hasher } from "./parser/parser.svelte";
import { characterURLImport } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import { chatEntry, chatList, currentChatRef, ensureChat, selectChat, type ChatRef } from "./storage/chatStore.svelte";
import { selectCharacter, setChatOpen } from "./storage/selection.svelte";
import {
    readAsset,
    readAssets,
    missingAssets,
    assetContentHash,
    throwIfAborted,
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
import { aiDisclosureEnabled } from "./platform";

/**
 * Client facade for asset bytes and URLs, remote fetches and tab request logs, downloads and
 * writers, and navigation/UI helpers. Re-exports preserve the same state objects as their owners.
 *
 * Asset transport, cancellation, retries and upload checks belong to src/ts/storage/assetClient.ts;
 * shared/assetBatch.ts defines the batch framing. URL selection and fallback source lifetimes are
 * specified on getFileSrc and holdFileSrc here; public/sw.js controls signed subresource loads.
 *
 * Fetch routing and failure rules live on globalFetch and fetchNative here. Host classification
 * comes through src/ts/network/localNetwork.ts from shared/localNetwork.ts; proxy authentication
 * comes from src/ts/storage/serverAuth.ts, and src/ts/stores.svelte.ts supplies body interceptors.
 * The log helpers keep this tab's newest-first array in place, separate from server request history
 * displayed by src/lib/Others/RequestLogs/ServerRequestHistory.svelte.
 *
 * Save entry points, conflict/restore handling and the re-exported saving indicator belong to
 * src/ts/storage/resourceSync.svelte.ts. Chat folds belong to src/ts/chatFold.svelte.ts; character
 * order repair belongs to src/ts/storage/characterOrder.ts.
 */

/** Fold state and actions owned by src/ts/chatFold.svelte.ts. */
export { chatFoldedState, chatFoldedStateMessageIndex, foldChatToMessage } from "./chatFold.svelte";

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

/** Entry-count ceiling for this tab's request log, independent of server history. */
const FETCH_LOG_MAX_ENTRIES = 20;
/** UTF-16 code-unit budget for retained body, header and response strings (newest entry excepted). */
const FETCH_LOG_MAX_CHARS = 16 * 1024 * 1024;
/** This tab's live request-log array; readers keep its identity, so writers must trim in place. */
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

/** Downloads bytes or a string as octet-stream data; a Blob passes through without a copy, keeping its type. */
export async function downloadFile(name: string, dat: Uint8Array | ArrayBuffer | string | Blob) {
    if (typeof dat === "string") {
        dat = Buffer.from(dat, "utf-8");
    }
    const blob = dat instanceof Blob ? dat : new Blob([new Uint8Array(dat)], { type: "application/octet-stream" });
    const downloadURL = (data: string, fileName: string) => {
        const a = document.createElement("a");
        a.href = data;
        a.download = fileName;
        document.body.appendChild(a);
        a.style.display = "none";
        a.click();
        a.remove();
    };

    const url = URL.createObjectURL(blob);

    downloadURL(url, name);

    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 10000);
}

type FileSource = {
    src: Promise<string>;
    url: string | null;
    failure?: { error: unknown };
    pinned: boolean;
    holders: number;
    revokeTimer?: ReturnType<typeof setTimeout>;
};

/**
 * One shared fallback load per path, pinned by plain reads for the page or held by previews.
 * Empty results are dropped so the next read tries again; controller loss drops resolved worker URLs.
 * Terminal failures are retained on the source for opt-in readers without rejecting its shared promise.
 */
const fileSources = new Map<string, FileSource>();
/** Let rows shifted by a list edit re-hold their sources before releasing their blobs. */
const FILE_SOURCE_RELEASE_GRACE_MS = 100;

/** How long a service-worker request may take before the read falls back to an object URL. */
const SW_REQUEST_TIMEOUT_MS = 10_000;
let swCache: Promise<Cache> | undefined;

/** Drops resolved worker URLs on controller loss, preserving blobs and pending loads and their holds. */
export function invalidateWorkerFileSources(): void {
    for (const [loc, source] of fileSources) {
        if (source.url?.startsWith("/sw/img/")) fileSources.delete(loc);
    }
}

/**
 * Direct mode resolves `/api/asset/<hex of the UTF-8 key>` at once (`""` for an empty key), without
 * a read, Cache Storage lookup, registration, shared file source, or pin: nothing needs revoking.
 * `public/sw.js` signs the subresource load; the browser HTTP cache holds the bytes. A missing file
 * is not detected here: its element receives a 404. Direct-mode 401s and network failures never
 * retry through `readAsset`.
 *
 * Each call checks `usingSw`, `directAssets`, and a controlling worker. Controller loss or a
 * capability re-probe sends new calls through the fallback; switching modes leaves existing
 * fallback sources' pin and hold lifetimes intact.
 * Fallback failures resolve `""` unless `rejectFailedReads` is set. Missing/empty files and empty keys
 * always resolve `""`; direct mode never rejects. Default reads keep the shared fallback promise.
 *
 * @param {string} loc - The location of the file.
 * @returns {Promise<string>} - A promise that resolves to the source URL of the file.
 */
export function getFileSrc(loc: string, options: { rejectFailedReads?: boolean } = {}): Promise<string> {
    if (canUseDirectAssets()) {
        return Promise.resolve(directAssetSrc(loc));
    }
    const source = getFileSource(loc);
    source.pinned = true;
    if (options.rejectFailedReads) {
        return source.src.then((src) => {
            if (source.failure) throw source.failure.error;
            return src;
        });
    }
    return source.src;
}

/**
 * Preview source and release handle; direct URLs need no release. In the fallback, the last release
 * revokes and drops an unpinned `blob:` URL after `FILE_SOURCE_RELEASE_GRACE_MS`. A new hold or plain
 * read cancels that timer. Worker URLs are never revoked.
 */
export function holdFileSrc(loc: string): { src: Promise<string>; release(): void } {
    if (canUseDirectAssets()) {
        return { src: Promise.resolve(directAssetSrc(loc)), release() {} };
    }
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

/**
 * Direct mode adds `?w=<size>`: `server/src/routes/storage.ts` serves a WebP thumbnail or a 307 to
 * the query-free original, followed by `public/sw.js`. Otherwise returns `getFileSrc`'s own promise
 * for the full image: pages without a worker, uncontrolled pages, and fallback loads get no
 * decoded-memory saving, an accepted trade-off.
 */
export function getThumbSrc(loc: string, size: 256 | 512): Promise<string> {
    if (canUseDirectAssets()) {
        return Promise.resolve(loc ? directAssetSrc(loc) + "?w=" + size : "");
    }
    return getFileSrc(loc);
}

/**
 * Direct URL for inlay audio and video in `src/ts/parser/parser.svelte.ts`; null without a capable
 * controlling worker, so the parser can use its own object URL fallback.
 */
export function getDirectAssetSrc(loc: string): string | null {
    return canUseDirectAssets() ? directAssetSrc(loc) : null;
}

function canUseDirectAssets(): boolean {
    return usingSw && directAssets && !!navigator.serviceWorker?.controller;
}

function directAssetSrc(loc: string): string {
    return loc ? "/api/asset/" + Buffer.from(loc, "utf-8").toString("hex") : "";
}

function directAssetFetchUrl(input: RequestInfo | URL): string | null {
    try {
        const url = new URL(input instanceof Request ? input.url : input, location.href);
        if (url.origin !== location.origin) return null;
        const hex = /^\/(?:api\/asset|sw\/img)\/((?:[\da-fA-F]{2})+)$/.exec(url.pathname)?.[1];
        if (!hex) return null;
        const key = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(hex, "hex"));
        if (!key.startsWith("assets/")) return null;
        url.pathname = "/api/asset/" + hex;
        return url.href;
    } catch {
        return null;
    }
}

/**
 * Signs same-origin `assets/` URLs on GET/HEAD without a `risu-auth` header, using a fresh token.
 * Legacy `/sw/img/<hex>` URLs map to `/api/asset/<hex>` so rows rendered before worker activation
 * cleared their cache entries remain fetchable. Signed requests use `mode: "same-origin"` so a
 * redirect cannot leave the origin. Other requests pass through unchanged.
 */
async function fetchFileSrcWith(
    originalFetch: typeof fetch,
    input: RequestInfo | URL,
    init?: RequestInit,
    active: () => boolean = () => true,
): Promise<Response> {
    const url = active() ? directAssetFetchUrl(input) : null;
    if (url) {
        const request = input instanceof Request ? input : undefined;
        const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
        const headers = new Headers(init?.headers ?? request?.headers);
        if ((method === "GET" || method === "HEAD") && !headers.has("risu-auth")) {
            const token = await getNodeServerProxyAuth();
            if (active()) {
                headers.set("risu-auth", token);
                return originalFetch.call(globalThis, request ? new Request(url, request) : url, {
                    ...init,
                    headers,
                    mode: "same-origin",
                });
            }
        }
    }
    return originalFetch.call(globalThis, input, init);
}

/**
 * Rich copy in `src/lib/ChatScreens/Chat.svelte` needs bytes for message images and character/user
 * icons; `public/sw.js` signs subresource loads but does not sign `fetch()`.
 */
export function fetchFileSrc(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return fetchFileSrcWith(fetch, input, init);
}

let fileSrcFetchScope:
    { depth: number; active: boolean; originalFetch: typeof fetch; wrapper: typeof fetch } | undefined;

/**
 * Screenshot capture in `src/lib/ChatScreens/DefaultChatScreen.svelte` signs fetches for images,
 * computed-style URLs from shared chat styles outside the rows, and fonts. Nested runs share one
 * wrapper; the last run disables signing and restores fetch only if global fetch is still this
 * wrapper. A wrapper retained by another script stays inactive.
 */
export async function withFileSrcFetch<T>(run: () => T | Promise<T>): Promise<T> {
    if (!fileSrcFetchScope) {
        const originalFetch = globalThis.fetch;
        const scope = {
            depth: 0,
            active: true,
            originalFetch,
            wrapper: ((input, init) =>
                fetchFileSrcWith(originalFetch, input, init, () => scope.active)) as typeof fetch,
        };
        // Plugins can already read any assets/ key through v3 readImage; signing these during capture grants nothing new.
        fileSrcFetchScope = scope;
        globalThis.fetch = scope.wrapper;
    }
    const scope = fileSrcFetchScope;
    scope.depth++;
    try {
        return await run();
    } finally {
        if (--scope.depth === 0) {
            scope.active = false;
            if (globalThis.fetch === scope.wrapper) {
                globalThis.fetch = scope.originalFetch;
            }
            fileSrcFetchScope = undefined;
        }
    }
}

function getFileSource(loc: string): FileSource {
    let source = fileSources.get(loc);
    if (!source) {
        source = { src: Promise.resolve(""), url: null, pinned: false, holders: 0 };
        source.src = loadFileSrc(loc, source);
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

/**
 * Fallback URL: `/sw/img/<hex>` only with a controlling worker and a cached file. The page shares `risuCache`
 * with the worker, so a Cache Storage hit needs no worker request; a miss posts bytes to
 * `/sw/register/<hex>`. When Cache Storage is unavailable or denied, `/sw/check/<hex>` answers
 * instead. Every worker request is bounded by `SW_REQUEST_TIMEOUT_MS`.
 *
 * Without a controller (checked again after worker awaits), with `usingSw` false, or after a failed
 * worker request, falls back to a `blob:` URL of type `image/png`.
 * Never a data URL: it would inflate the text `serverProcessScript` sends to the server in
 * `src/ts/parser/transformClient.ts`. Missing or empty bytes are never registered or shown: they
 * resolve `""`, as does an empty key or failed load. Only terminal non-missing failures are recorded
 * on the shared source for opt-in readers; a successful blob fallback records no failure.
 */
async function loadFileSrc(loc: string, source: FileSource): Promise<string> {
    if (!loc) return "";
    let bytes: Promise<Uint8Array> | null = null;
    const read = () =>
        (bytes ??= (async () => {
            const data = (await readAsset(loc)) as unknown as Uint8Array | null;
            if (!data || data.length === 0) {
                throw new MissingFileError(loc);
            }
            return data;
        })());
    try {
        if (usingSw && navigator.serviceWorker?.controller) {
            try {
                const encoded = Buffer.from(loc, "utf-8").toString("hex");
                const url = "/sw/img/" + encoded;
                let hasCache: boolean;
                try {
                    const cache = await (swCache ??= caches.open("risuCache"));
                    hasCache = !!(await cache.match(url));
                } catch {
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
                if (navigator.serviceWorker?.controller) return url;
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
        if (!(error instanceof MissingFileError)) source.failure = { error };
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
 * Saves an asset file, skipping a canonical upload when the server already holds verified bytes.
 * A failed or timed-out check uploads normally; custom ids always write.
 *
 * @param {Uint8Array} data - The data of the asset file.
 * @param {string} [customId=''] - The custom ID for the asset file.
 * @param {string} [fileName=''] - The name of the asset file.
 * @param {AssetRequestOptions} [options] - `signal` aborts the check, write, and retries with its reason.
 * @returns {Promise<string>} - A promise that resolves to the path of the saved asset file.
 */
export async function saveAsset(
    data: Uint8Array,
    customId: string = "",
    fileName: string = "",
    options: AssetRequestOptions = {},
) {
    const form = await assetKey(data, customId, fileName);
    if (customId === "" && assetContentHash(form) !== null) {
        try {
            const missing = await missingAssets([form], options);
            throwIfAborted(options.signal);
            if (!missing.has(form)) {
                return form;
            }
        } catch (error) {
            throwIfAborted(options.signal);
            console.warn("Asset missing check failed; uploading asset", error);
        }
    }
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

/** Checks canonical items with matching `sha256`, then batches uploads through `writeAssets` with retries. */
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

/** The save adapter's shared write-activity indicator; see src/ts/storage/resourceSync.svelte.ts. */
export { saving } from "./storage/resourceSync.svelte";

let usingSw = false;
let directAssets = false;

/** Records whether `registerSw` in `src/ts/bootstrap.ts` returned `ready`, separately from capability. */
export function setUsingSw(value: boolean) {
    usingSw = value;
}

/**
 * Records the controlling worker's `/sw/init` `directAssets` capability from `src/ts/bootstrap.ts`.
 * Non-JSON responses (including older workers), missing or false flags, unavailable workers, and
 * unsupported browsers leave it false. `controllerchange` clears it and probes the new controller;
 * only the newest probe for the current controller can set it again.
 */
export function setDirectAssets(value: boolean) {
    directAssets = value;
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
 * Buffered remote call with tab logging and `{ ok, data, headers, status }` results. Routing uses
 * `shared/localNetwork.ts`: a qualifying `networkRoute: "local_network"` always takes the proxy;
 * otherwise localhost/127.0.0.1/0.0.0.0, `plainFetchForce`, or `settings.providers.usePlainFetch`
 * selects plain fetch unless `plainFetchDeforce`; then userscript `userScriptFetch`, else proxy.
 * `bodyIntercepterStore` interceptors run before dispatch, logging throws and retaining the body
 * so far. The timeout starts after those interceptors, covers the selected buffered transport,
 * and combines with `abortSignal`; its timer/listener is removed on settlement.
 * The method defaults to POST. Proxy encoding and headers are governed by `fetchWithProxy`.
 * An already-aborted call, routing error, or transport failure becomes `ok: false`, status 400.
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
 * Same-origin `/proxy2` exchange (`server/src/routes/proxy.ts`): `risu-url` is the encoded target,
 * `risu-header` the encoded JSON upstream headers. A fresh JWT is sent as `risu-auth` when present,
 * `useRisuToken` adds `x-risu-tk: use`, and `requestTimeoutMs` adds `risu-timeout-ms` (floored,
 * at least 1). These outer headers are separate from the upstream headers.
 * URLSearchParams uses form encoding; other bodies use JSON, with matching default content types.
 * Method defaults to POST. Raw responses return bytes; otherwise a non-JSON response is a failure
 * even on HTTP success. Transport/auth errors become status 400 results; response reads are logged.
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

/** Returns the final path segment after converting backslashes to slashes; a trailing separator yields "". */
export function getBasename(data: string) {
    const splited = data.replace(re, "/").split("/");
    const lasts = splited[splited.length - 1];
    return lasts;
}

/**
 * The `characterOrder` mutation from `src/ts/storage/characterOrder.ts`, kept on this facade for
 * `src/ts/characters.ts` and the plugin API in `src/ts/plugins/apiV3/v3.svelte.ts`.
 */
export { checkCharOrder } from "./storage/characterOrder";

/** Returns this tab's live log array, whose identity writers preserve; it is not server history. */
export function getFetchLogs() {
    return fetchLog;
}

/**
 * Opens a new tab with `noopener,noreferrer`, isolating its opener and initial session storage from this tab.
 *
 * @param {string} url - The URL to open.
 */
export function openURL(url: string) {
    // `noopener`: the new page gets no `window.opener`, and a same-origin page opened this way starts
    // with its own `sessionStorage` instead of a copy of this tab's (the live-page claim counts tabs).
    window.open(url, "_blank", "noopener,noreferrer");
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
 * Streams a download through `streamsaver`. `writeBackup` frames each record as a native-endian
 * Uint32 UTF-8 basename byte length, basename bytes, Uint32 data byte length, then data bytes;
 * `write` instead passes bytes through unchanged.
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
 * In-memory writer over `AppendableBuffer`; close and abort leave its accumulated bytes available.
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
 * `deappend` discards bytes from the front; slice offsets and length still count from the original
 * stream start, while `buffer` copies only the retained bytes.
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
            let newLength = Math.max(this.#buffer.byteLength, 128);
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
 * Streaming remote call returning a `Response`; transport failures reject. Accepts an optional
 * string, Uint8Array, or ArrayBuffer body. Method defaults to POST; exact GET/HEAD discard the
 * body, while DELETE/PATCH retain it. String bodies alone run `bodyIntercepterStore` interceptors
 * before encoding (throws are logged and the body so far kept).
 * A qualifying `networkRoute: "local_network"` (`shared/localNetwork.ts`) takes same-origin
 * `/proxy2`; otherwise userscript `userScriptFetch` when present, else direct fetch. The proxy
 * sends encoded `risu-url` and JSON `risu-header`, outer Content-Type application/json, a fresh
 * `risu-auth` JWT when present, optional `x-risu-tk: use` (`useRisuTk`), and `risu-timeout-ms`
 * (`requestTimeoutMs`, floored to at least 1). The request body remains its encoded bytes.
 * Timeout starts after interceptors and combines with `signal` until transport settlement, not
 * until the returned stream is consumed. Logging defaults on, records a streamed-fetch placeholder
 * before dispatch, and does not consume the response. The plugin adapter's GET default and body
 * normalization are in `src/ts/plugins/apiV3/v3.svelte.ts`.
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

/** ASCII-only: accented Latin letters are removed too. */
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

/** Collects elapsed milliseconds by key from one shared start time, merges samples and logs their averages. */
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

/** The persisted UI locale `cn` is passed to Intl as `zh`. */
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

/** The upstream RisuAI version this build is compatible with (`appVer`), with `appSubVer` when set. */
export function getVersionString(): string {
    let versionString = appVer;
    if (appSubVer) {
        versionString += "-" + appSubVer;
    }
    return versionString;
}

/**
 * Whether the client shows its AI disclosure: the empty-chat warning (`DefaultChatScreen`), the request-info
 * disclaimer (`AlertComp`), and the chat row's model button regardless of `requestInfoInsideChat` (`Chat`). It is the
 * page flag `aiDisclosureEnabled` (`src/ts/platform.ts`), set by the server operator through `RISU_AI_DISCLOSURE`
 * and off by default.
 */
export function aiLawApplies(): boolean {
    return aiDisclosureEnabled;
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

/**
 * Shared home/rail navigation by `{ chaId, chatId }` (per tab). Selects the chat before its character
 * so only the target chat is loaded; a missing character or chat entry leaves selection unchanged.
 */
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
