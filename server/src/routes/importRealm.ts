import type { Context, Hono, MiddlewareHandler } from "hono";
import { CharxFileError, INVALID_CHARX_FILE } from "../../../shared/charxImport.ts";
import {
    REALM_API_VERSION,
    REALM_DOWNLOAD_FAILED,
    REALM_ID_PATTERN,
    REALM_IMPORT_PATH,
    REALM_ORIGIN,
    type RealmJsonResult,
    realmDownloadURL,
} from "../../../shared/realmImport.ts";
import type { SnapshotManager } from "../data/snapshots.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";
import {
    createImportSlot,
    type FileImportSource,
    type FileImportStream,
    type ImportSlot,
    serveFileImport,
} from "../http/fileImport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { ndjsonLine } from "../http/spool.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { type CharxFilePlan, charxLines, planCharxFile } from "./importCharx.ts";
import { PngFileError, type PngFilePlan, planPngFile, pngLines } from "./importPng.ts";

export { REALM_IMPORT_PATH };

/** How long Realm may take to answer with its headers (redirects included). */
const REALM_HEADERS_TIMEOUT_MS = 30_000;
/** How long Realm may go without sending the next piece of a body. */
const REALM_BODY_IDLE_TIMEOUT_MS = 60_000;
const MAX_REALM_REDIRECTS = 3;
/** The cap of a legacy JSON answer (a card without its images: they are hub resources). */
const MAX_REALM_JSON_BYTES = 16 * 1024 * 1024;
/** How much of a refusal's text is read and passed on, and how long that read may take in all. */
const MAX_REALM_ERROR_BYTES = 4096;
const REALM_ERROR_READ_TIMEOUT_MS = 10_000;
/** The request body: `{ id }`. */
const MAX_REALM_REQUEST_BYTES = 4096;
/** Where a Realm redirect may lead besides the Realm origin itself: HTTPS hosts of these domains. */
const REALM_REDIRECT_DOMAINS = ["risuai.net", "risuai.xyz"];

type RealmKind = "charx" | "png" | "json";

type RealmPlan =
    { kind: "charx"; plan: CharxFilePlan } | { kind: "png"; plan: PngFilePlan } | { kind: "json"; body: string };

/** The Realm download itself failed (no answer in time, a refused redirect, a broken body): a 502. */
class RealmDownloadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RealmDownloadError";
    }
}

/**
 * `POST /api/import/realm` (`shared/realmImport.ts`): the body `{ id }` (at most 4 KiB) names a Realm
 * card; the server downloads it from the fixed Realm endpoint and reads it with the CharX reader
 * (`routes/importCharx.ts`), the PNG reader (`routes/importPng.ts`), or passes a legacy JSON answer
 * through. The request lifecycle is `serveFileImport`'s (`http/fileImport.ts`) with the download as
 * the file's source: authenticated first, refused while another import holds the shared slot (409)
 * or during maintenance (503); then, holding the slot, the request body is read (`readRealmId`), the
 * download is spooled to `save/.tmp/realm-<uuid>/realm.file` under `maxImportBytes` (a JSON answer
 * under 16 MiB; an unencoded answer whose `content-length` is over the cap is refused before its
 * body is read) and validated before anything is written.
 *
 * The download (never a URL from the request): `GET` with only the `x-risu-api-version` header, the
 * client's disconnect aborting it. Redirects are followed by hand, at most 3, only to the Realm origin
 * or an HTTPS host under `risuai.net`/`risuai.xyz` on the default port. The headers must arrive within
 * 30 s; the body may not stall for 60 s (there is no total deadline: a client that stops waiting
 * disconnects, which aborts the download). A Realm answer other than 200 is a 502 with Realm's text
 * (its first 4 KiB, or what arrived of them within 10 s, or `Realm answered <status>`); a download
 * that fails is a 502 `REALM_DOWNLOAD_FAILED`; a file neither reader accepts is a 400 `Invalid
 * character file` (`INVALID_CHARX_FILE`, as the CharX import).
 */
export function registerRealmImportRoutes(
    app: Hono<AppEnv>,
    arg: {
        savePath: string;
        snapshots: SnapshotManager;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maxImportBytes: number;
        /** The diagnostics journal: a `lifecycle` event after a download was read. */
        diagnostics?: DiagnosticsRecorder;
        /** The import slot shared with the module and CharX imports; a slot of its own without one. */
        slot?: ImportSlot;
        /** The Realm origin (tests replace it); default `REALM_ORIGIN`. */
        realmOrigin?: string;
    },
) {
    const { savePath, snapshots, auth, limiter, maxImportBytes, diagnostics } = arg;
    const realmOrigin = arg.realmOrigin ?? REALM_ORIGIN;
    const deps = { savePath, snapshots, auth, maxImportBytes, slot: arg.slot ?? createImportSlot() };
    const readers = { savePath, snapshots, diagnostics };

    // The body is read only once the import is authenticated and admitted (`readRealmId`).
    app.post(REALM_IMPORT_PATH, limiter, (c) =>
        serveFileImport<RealmPlan, RealmKind>(c, deps, {
            stagingPrefix: "realm",
            fileName: "realm.file",
            missingBody: "Realm id required",
            source: (c, signal) => openRealmDownload(c, signal, realmOrigin, maxImportBytes),
            prepare: async (handle, kind, signal) => {
                if (kind === "charx") {
                    return { kind, plan: await planCharxFile(handle) };
                }
                if (kind === "png") {
                    return { kind, plan: await planPngFile(handle, signal) };
                }
                return { kind, body: new TextDecoder().decode(await handle.readFile()) };
            },
            refusal,
            lines: (plan, stream) => {
                if (plan.kind === "charx") {
                    return charxLines(readers, plan.plan, stream, { phase: "realmImport", kind: "charx" });
                }
                if (plan.kind === "png") {
                    return pngLines(readers, plan.plan, stream);
                }
                return jsonLines(plan.body, stream, diagnostics);
            },
        }),
    );
}

/**
 * Reads the request's id and opens the download (see the route comment): a `Response` for a refusal,
 * or the body to spool with its cap and kind. Throws `RealmDownloadError` for a failed download.
 */
async function openRealmDownload(
    c: Context<AppEnv>,
    signal: AbortSignal,
    realmOrigin: string,
    maxImportBytes: number,
): Promise<FileImportSource<RealmKind> | Response> {
    const id = await readRealmId(c);
    if (id instanceof Response) {
        return id;
    }

    const upstream = new AbortController();
    const onAbort = () => upstream.abort(signal.reason);
    if (signal.aborted) {
        onAbort();
    } else {
        signal.addEventListener("abort", onAbort, { once: true });
    }
    const cancel = () => {
        signal.removeEventListener("abort", onAbort);
        upstream.abort();
    };

    let response: Response;
    try {
        response = await fetchRealm(realmDownloadURL(id, realmOrigin), upstream, realmOrigin);
    } catch (error) {
        cancel();
        throw error instanceof RealmDownloadError ? error : new RealmDownloadError(String(error));
    }
    if (response.status !== 200) {
        const text = await readUpstreamText(response, upstream).catch(() => "");
        cancel();
        return c.json({ error: text.trim() || `Realm answered ${response.status}` }, 502);
    }
    if (!response.body) {
        cancel();
        throw new RealmDownloadError("Realm answered without a body");
    }
    const kind = realmKind(response.headers.get("content-type"));
    const limit = kind === "json" ? Math.min(MAX_REALM_JSON_BYTES, maxImportBytes) : maxImportBytes;
    // The declared length is the decoded length only without a content encoding (`fetch` decodes a
    // compressed body, which may grow or shrink); otherwise only the spool's decoded count applies.
    const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
    const declared = Number(response.headers.get("content-length") ?? "");
    if ((encoding === "" || encoding === "identity") && Number.isFinite(declared) && declared > limit) {
        await response.body.cancel().catch(() => {});
        cancel();
        return c.json({ error: "File too large" }, 413);
    }
    return { body: guardedBody(response.body, upstream), limit, meta: kind, cancel };
}

/**
 * The request's Realm id: the body is JSON `{ id }` of at most `MAX_REALM_REQUEST_BYTES`, read here
 * (inside the admitted import) rather than by a body-limit middleware ahead of authentication. A
 * `Response` for a refusal: 413 past the cap, 400 for anything else that is not a valid id.
 */
async function readRealmId(c: Context<AppEnv>): Promise<string | Response> {
    const invalid = () => c.json({ error: "Invalid Realm id" }, 400);
    const contentType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const body = c.req.raw.body;
    if (contentType !== "application/json" || !body) {
        return invalid();
    }
    const reader = body.getReader();
    const pieces: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            length += value.byteLength;
            if (length > MAX_REALM_REQUEST_BYTES) {
                void reader.cancel().catch(() => {});
                return c.json({ error: "Request body too large" }, 413);
            }
            pieces.push(value);
        }
    } catch {
        return invalid();
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(pieces)));
    } catch {
        return invalid();
    }
    const id = isPlainObject(parsed) ? parsed.id : undefined;
    return typeof id === "string" && REALM_ID_PATTERN.test(id) ? id : invalid();
}

/** The reader a Realm answer's `content-type` (without parameters, any case) selects. */
function realmKind(contentType: string | null): RealmKind {
    const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
    if (type === "image/png") {
        return "png";
    }
    if (type === "application/zip" || type === "application/charx") {
        return "charx";
    }
    return "json";
}

/**
 * Fetches `url`, following at most `MAX_REALM_REDIRECTS` redirects by hand to allowed hosts, until
 * the answer's headers arrive (within `REALM_HEADERS_TIMEOUT_MS`).
 */
async function fetchRealm(url: string, upstream: AbortController, realmOrigin: string): Promise<Response> {
    const timer = setTimeout(
        () => upstream.abort(new RealmDownloadError("Realm did not answer in time")),
        REALM_HEADERS_TIMEOUT_MS,
    );
    try {
        let target = new URL(url);
        for (let hop = 0; ; hop++) {
            const response = await fetch(target, {
                headers: { "x-risu-api-version": REALM_API_VERSION },
                redirect: "manual",
                signal: upstream.signal,
            });
            const location = response.headers.get("location");
            if (response.status < 300 || response.status >= 400 || !location) {
                return response;
            }
            await response.body?.cancel().catch(() => {});
            if (hop >= MAX_REALM_REDIRECTS) {
                throw new RealmDownloadError("Realm redirected too many times");
            }
            const next = new URL(location, target);
            if (!isRealmHost(next, realmOrigin)) {
                throw new RealmDownloadError(`Realm redirected to ${next.origin}`);
            }
            target = next;
        }
    } catch (error) {
        const reason = upstream.signal.reason;
        throw reason instanceof RealmDownloadError ? reason : error;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Whether a redirect may lead to `url`: the Realm origin, or an HTTPS host under the Realm's domains on
 * the default port.
 */
function isRealmHost(url: URL, realmOrigin: string): boolean {
    if (url.origin === new URL(realmOrigin).origin) {
        return true;
    }
    if (url.protocol !== "https:" || url.port !== "") {
        return false;
    }
    const host = url.hostname.toLowerCase();
    return REALM_REDIRECT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * The upstream body, each read bounded by `REALM_BODY_IDLE_TIMEOUT_MS`; a read that fails or stalls
 * aborts the download and errors the stream with a `RealmDownloadError`. Cancelling it aborts the
 * download.
 */
function guardedBody(body: ReadableStream<Uint8Array>, upstream: AbortController): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const stalled = new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new RealmDownloadError("Realm stopped sending the file")),
                    REALM_BODY_IDLE_TIMEOUT_MS,
                );
            });
            try {
                const { value, done } = await Promise.race([reader.read(), stalled]);
                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(value);
                }
            } catch (error) {
                upstream.abort();
                void reader.cancel().catch(() => {});
                controller.error(error instanceof RealmDownloadError ? error : new RealmDownloadError(String(error)));
            } finally {
                clearTimeout(timer);
            }
        },
        cancel(reason) {
            upstream.abort();
            return reader.cancel(reason).catch(() => {});
        },
    });
}

/**
 * The first `MAX_REALM_ERROR_BYTES` of a refusal's body as UTF-8 text, or what arrived of them within
 * `REALM_ERROR_READ_TIMEOUT_MS` (the download is then aborted); the rest is cancelled.
 */
async function readUpstreamText(response: Response, upstream: AbortController): Promise<string> {
    if (!response.body) {
        return "";
    }
    const reader = guardedBody(response.body, upstream).getReader();
    const deadline = setTimeout(() => upstream.abort(), REALM_ERROR_READ_TIMEOUT_MS);
    const pieces: Uint8Array[] = [];
    let length = 0;
    try {
        while (length < MAX_REALM_ERROR_BYTES) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            pieces.push(value);
            length += value.byteLength;
        }
    } catch {
        // Stopped by the deadline or a broken body: what arrived is the text.
    } finally {
        clearTimeout(deadline);
        void reader.cancel().catch(() => {});
    }
    return new TextDecoder().decode(Buffer.concat(pieces).subarray(0, MAX_REALM_ERROR_BYTES));
}

/** A legacy JSON answer's one line. Never throws; sends its line once `finalize` has run. */
async function* jsonLines(
    body: string,
    { finalize }: FileImportStream,
    diagnostics: DiagnosticsRecorder | undefined,
): AsyncGenerator<Uint8Array> {
    try {
        const line = ndjsonLine({ kind: "json", body } satisfies RealmJsonResult);
        recordSafely(diagnostics, { kind: "lifecycle", phase: "realmImport" });
        await finalize();
        yield line;
    } finally {
        await finalize();
    }
}

/** The route's refusal before the stream started (maintenance and any other error are `serveFileImport`'s). */
function refusal(c: Context<AppEnv>, error: unknown): Response | null {
    if (error instanceof CharxFileError || error instanceof PngFileError) {
        return c.json({ error: INVALID_CHARX_FILE }, 400);
    }
    if (error instanceof RealmDownloadError) {
        console.warn("[Server] Realm download failed:", error.message);
        return c.json({ error: REALM_DOWNLOAD_FAILED }, 502);
    }
    return null;
}
