import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { type CharxImportFailure, CharxFileError, INVALID_CHARX_FILE } from "../../../shared/charxImport.ts";
import {
    MAX_REALM_STAGED,
    REALM_API_VERSION,
    REALM_CANCEL_PATH,
    REALM_COMMIT_PATH,
    REALM_DOWNLOAD_FAILED,
    REALM_ID_PATTERN,
    REALM_IMPORT_EXPIRED,
    REALM_IMPORT_PATH,
    REALM_ORIGIN,
    REALM_STAGED_TTL_MS,
    REALM_TOKEN_PATTERN,
    REALM_TOO_MANY_STAGED,
    type RealmJsonResult,
    type RealmPrepared,
    realmDownloadURL,
} from "../../../shared/realmImport.ts";
import type { SnapshotManager } from "../data/snapshots.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";
import {
    createImportSlot,
    type FileImportSource,
    type FileImportStream,
    type ImportSlot,
    type StagedFile,
    serveFileImport,
    serveStagedImport,
} from "../http/fileImport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { ndjsonLine } from "../http/spool.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { type CharxFilePlan, charxLines, planCharxFile, readCharxCardParts } from "./importCharx.ts";
import { PngFileError, type PngFilePlan, planPngFile, pngLines } from "./importPng.ts";

export { REALM_CANCEL_PATH, REALM_COMMIT_PATH, REALM_IMPORT_PATH };

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
/** The request bodies: `{ id }`, `{ token }`. */
const MAX_REALM_REQUEST_BYTES = 4096;
/** The spooled download's name in its staging folder. */
const REALM_FILE_NAME = "realm.file";
/** Where a Realm redirect may lead besides the Realm origin itself: HTTPS hosts of these domains. */
const REALM_REDIRECT_DOMAINS = ["risuai.net", "risuai.xyz"];

type RealmKind = "charx" | "png" | "json";

/** What the prepare read: a CharX file's plan and card parts, a PNG's plan (its card text in it), or a JSON answer's text. */
type RealmPlan =
    | { kind: "charx"; plan: CharxFilePlan; card: string; moduleData: string | null }
    | { kind: "png"; plan: PngFilePlan }
    | { kind: "json"; body: string };

/** What a staged import keeps for its commit: the plan of its file, without the card text the tab has. */
export type RealmStagedPlan = { kind: "charx"; plan: CharxFilePlan } | { kind: "png"; plan: { total: number } };

/** The Realm download itself failed (no answer in time, a refused redirect, a broken body): a 502. */
class RealmDownloadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RealmDownloadError";
    }
}

/**
 * The staged Realm imports (see `registerRealmImportRoutes`): each waits, outside the import slot, for
 * its commit or cancel, at most `ttlMs` (`REALM_STAGED_TTL_MS`) from its prepare's answer, and at most
 * `MAX_REALM_STAGED` at once. Expiry, cancel, and `close` (shutdown) remove the staging folder; a
 * commit takes the import out (`take`), and its finalizer removes the folder. Maintenance leaves them
 * (a restore replaces the database, not `save/.tmp`; a commit during it is refused and keeps its
 * import). What a crash leaves under `save/.tmp` is emptied at the next start (`routes/storage.ts`).
 */
export type RealmStaging = ReturnType<typeof createRealmStaging>;

type StagedRealmImport = StagedFile<RealmStagedPlan> & { timer: ReturnType<typeof setTimeout> };

export function createRealmStaging(options: { ttlMs?: number } = {}) {
    const ttlMs = options.ttlMs ?? REALM_STAGED_TTL_MS;
    const waiting = new Map<string, StagedRealmImport>();
    let closing: Promise<void> | null = null;
    const remove = (staged: StagedFile<RealmStagedPlan>) =>
        fs.rm(staged.staging, { recursive: true, force: true }).catch(() => {});
    /** Takes the import out of the store, so neither its timer nor `close` removes it. */
    const detach = (token: string): StagedRealmImport | null => {
        const staged = waiting.get(token) ?? null;
        if (staged) {
            clearTimeout(staged.timer);
            waiting.delete(token);
        }
        return staged;
    };
    const cancel = async (token: string) => {
        const staged = detach(token);
        if (staged) {
            await remove(staged);
        }
    };
    return {
        /** Whether a prepare would be refused: `MAX_REALM_STAGED` imports wait, or the store is closed. */
        get full() {
            return closing !== null || waiting.size >= MAX_REALM_STAGED;
        },
        /** The staged imports waiting (tests). */
        get size() {
            return waiting.size;
        },
        /** Stages a prepared file and answers its token; null once the store is full or closed. */
        add(staged: StagedFile<RealmStagedPlan>): string | null {
            if (closing !== null || waiting.size >= MAX_REALM_STAGED) {
                return null;
            }
            const token = randomUUID();
            const timer = setTimeout(() => {
                const expired = detach(token);
                if (expired) {
                    void remove(expired);
                }
            }, ttlMs);
            timer.unref?.();
            waiting.set(token, { ...staged, timer });
            return token;
        },
        /** Whether `token` names a waiting import. */
        has(token: string): boolean {
            return waiting.has(token);
        },
        /** Takes the import `token` names out for its commit (whose finalizer removes its folder). */
        take(token: string): StagedFile<RealmStagedPlan> | null {
            return detach(token);
        },
        /** Removes the import `token` names, if it still waits. */
        cancel,
        /** Removes every waiting import and refuses new ones (shutdown). Calling it again returns the same promise. */
        close(): Promise<void> {
            closing ??= Promise.all([...waiting.keys()].map(cancel)).then(() => {});
            return closing;
        },
    };
}

/**
 * The Realm import's routes (`shared/realmImport.ts`), in two steps so that the tab's questions about
 * the card come before anything is written:
 *
 * `POST /api/import/realm` (the prepare): the body `{ id }` (at most 4 KiB) names a Realm card; the
 * server downloads it from the fixed Realm endpoint and validates it with the CharX reader
 * (`routes/importCharx.ts`) or the PNG reader (`routes/importPng.ts`), or passes a legacy JSON answer
 * through. The request lifecycle is `serveFileImport`'s (`http/fileImport.ts`) with the download as
 * the file's source: authenticated first, refused while another import holds the shared slot (409)
 * or during maintenance (503); then, holding the slot, refused while `MAX_REALM_STAGED` imports wait
 * (409 `REALM_TOO_MANY_STAGED`), the request body is read (`readRealmId`), the download is spooled to
 * `save/.tmp/realm-<uuid>/realm.file` under `maxImportBytes` (a JSON answer under 16 MiB; an
 * unencoded answer whose `content-length` is over the cap is refused before its body is read) and
 * validated, and the card's parts are read (a CharX file's `card.json` and `module.risum`, a PNG's
 * card text: an empty or unreadable card is refused too). Nothing is written: the answer's one line is
 * the `RealmPrepared` with the staged import's token, the slot is free again, and the file waits in
 * `staging` for the commit (the JSON answer's line has no token; nothing is staged).
 *
 * `POST /api/import/realm/commit` with `{ token }`: `serveStagedImport`'s lifecycle (404
 * `REALM_IMPORT_EXPIRED` for a token that names no waiting import; 409 while another import holds the
 * slot and 503 during maintenance, the staged import kept); then the staged file's assets (and a PNG's
 * trimmed image) are written by the CharX or PNG lines, and the folder is removed when the answer
 * ends. `POST /api/import/realm/cancel` with `{ token }`: the staged import is removed, a 204 whether
 * it still waited or not. Both are authenticated first and read a 4 KiB JSON body (400 `Invalid
 * import token` for anything else).
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
        /** The diagnostics journal: a `lifecycle` event after a commit stored a file, or a JSON answer was read. */
        diagnostics?: DiagnosticsRecorder;
        /** The import slot shared with the module and CharX imports; a slot of its own without one. */
        slot?: ImportSlot;
        /** The staged imports (closed at shutdown by the caller); a store of its own without one. */
        staging?: RealmStaging;
        /** The Realm origin (tests replace it); default `REALM_ORIGIN`. */
        realmOrigin?: string;
    },
) {
    const { savePath, snapshots, auth, limiter, maxImportBytes, diagnostics } = arg;
    const realmOrigin = arg.realmOrigin ?? REALM_ORIGIN;
    const staging = arg.staging ?? createRealmStaging();
    const deps = { savePath, snapshots, auth, maxImportBytes, slot: arg.slot ?? createImportSlot() };
    const readers = { savePath, snapshots, diagnostics };

    // The body is read only once the import is authenticated and admitted (`readRealmId`).
    app.post(REALM_IMPORT_PATH, limiter, (c) =>
        serveFileImport<RealmPlan, RealmKind>(c, deps, {
            stagingPrefix: "realm",
            fileName: REALM_FILE_NAME,
            missingBody: "Realm id required",
            source: (c, signal) =>
                staging.full
                    ? Promise.resolve(c.json({ error: REALM_TOO_MANY_STAGED }, 409))
                    : openRealmDownload(c, signal, realmOrigin, maxImportBytes),
            prepare: async (handle, kind, signal) => {
                if (kind === "charx") {
                    const plan = await planCharxFile(handle);
                    const { card, moduleData } = await readCharxCardParts(handle, plan);
                    if (!card) {
                        throw new CharxFileError("The file holds no readable card.json");
                    }
                    return { kind, plan, card, moduleData };
                }
                if (kind === "png") {
                    return { kind, plan: await planPngFile(handle, signal) };
                }
                return { kind, body: new TextDecoder().decode(await handle.readFile()) };
            },
            refusal,
            lines: (plan, stream) => {
                if (plan.kind === "json") {
                    return jsonLines(plan.body, stream, diagnostics);
                }
                return preparedLines(staging, plan, stream);
            },
        }),
    );

    app.post(REALM_COMMIT_PATH, limiter, (c) =>
        serveStagedImport<RealmStagedPlan>(c, deps, {
            find: async (c) => {
                const token = await readRealmToken(c);
                if (token instanceof Response) {
                    return token;
                }
                if (!staging.has(token)) {
                    return c.json({ error: REALM_IMPORT_EXPIRED }, 404);
                }
                return {
                    take: () => {
                        const staged = staging.take(token);
                        if (!staged) {
                            throw new Error("The staged Realm import is gone");
                        }
                        return staged;
                    },
                };
            },
            refusal,
            lines: (plan, stream) =>
                plan.kind === "charx"
                    ? charxLines(readers, plan.plan, stream, { realm: true })
                    : pngLines(readers, plan.plan, stream),
        }),
    );

    app.post(REALM_CANCEL_PATH, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const token = await readRealmToken(c);
        if (token instanceof Response) {
            return token;
        }
        await staging.cancel(token);
        return c.body(null, 204);
    });
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
function readRealmId(c: Context<AppEnv>): Promise<string | Response> {
    return readRequestField(c, "id", REALM_ID_PATTERN, "Invalid Realm id");
}

/** A commit's or cancel's staged import token: `{ token }`, read as `readRealmId` reads `{ id }`. */
function readRealmToken(c: Context<AppEnv>): Promise<string | Response> {
    return readRequestField(c, "token", REALM_TOKEN_PATTERN, "Invalid import token");
}

/**
 * The string `field` of the request's JSON object body (at most `MAX_REALM_REQUEST_BYTES`) when it
 * matches `pattern`: 413 past the cap, 400 `invalidText` for anything else.
 */
async function readRequestField(
    c: Context<AppEnv>,
    field: string,
    pattern: RegExp,
    invalidText: string,
): Promise<string | Response> {
    const invalid = () => c.json({ error: invalidText }, 400);
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
    const value = isPlainObject(parsed) ? parsed[field] : undefined;
    return typeof value === "string" && pattern.test(value) ? value : invalid();
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

/**
 * A validated CharX or PNG download's one line: the file is staged (`staging.add`, the stream's
 * folder kept) and its `RealmPrepared` line, with the token, is sent once `finalize` has run (the slot
 * is free for the commit). A store closed by shutdown is one `{ error }` line, the folder removed. A
 * client that leaves after the file is staged leaves it to expire. Never throws.
 */
async function* preparedLines(
    staging: RealmStaging,
    prepared: Exclude<RealmPlan, { kind: "json" }>,
    { staging: folder, signal, finalize, keep }: FileImportStream,
): AsyncGenerator<Uint8Array> {
    try {
        if (signal.aborted) {
            return;
        }
        const plan: RealmStagedPlan =
            prepared.kind === "charx"
                ? { kind: "charx", plan: prepared.plan }
                : { kind: "png", plan: { total: prepared.plan.total } };
        const token = staging.add({ staging: folder, file: path.join(folder, REALM_FILE_NAME), plan });
        if (token === null) {
            await finalize();
            yield ndjsonLine({ error: "The server is shutting down" } satisfies CharxImportFailure);
            return;
        }
        keep();
        const line = ndjsonLine(
            (prepared.kind === "charx"
                ? { kind: "charx", token, card: prepared.card, moduleData: prepared.moduleData }
                : { kind: "png", token, card: prepared.plan.card }) satisfies RealmPrepared,
        );
        await finalize();
        yield line;
    } finally {
        await finalize();
    }
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
