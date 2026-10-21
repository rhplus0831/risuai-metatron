import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";
import { MaintenanceError, type SnapshotManager } from "../data/snapshots.ts";
import type { AuthStore } from "../routes/auth.ts";
import type { AppEnv } from "../types.ts";
import { iteratorStream } from "./recordStream.ts";
import { makeStaging, spool } from "./spool.ts";

/**
 * The lifecycle shared by the routes that import one whole file as the raw body and answer NDJSON:
 * the module import (`routes/importModule.ts`) and the CharX import (`routes/importCharx.ts`). Each
 * route supplies its validation, its refusals, and its lines; `serveFileImport` owns the rest, in
 * this order:
 *
 * 1. Refused before the body is read: authentication, a declared length over `maxImportBytes` (413
 *    `File too large`), another import holding the shared slot (409 `Another import is running`),
 *    maintenance (503 with `Retry-After: 5`), the route's own `preflight` refusal, no body (400 with
 *    the route's text).
 * 2. The lifetime is tracked (`snapshots.track`; 503 once shutdown stopped admissions), the slot
 *    taken, and the body spooled to `save/.tmp/<prefix>-<uuid>/<fileName>` under `maxImportBytes`
 *    (413 past it), then opened (`fs.open`, read-only) and validated by the route (`prepare`) before
 *    anything is written. A client gone by then is 400 `Request aborted`. A route with a `source`
 *    (the Realm download) has no declared-length or missing-body refusal: once the slot is taken it
 *    opens its source, whose body is spooled under the source's own cap, and the finalizer cancels it.
 * 3. The 200 answer is `application/x-ndjson` and `no-store`, streamed from the route's generator
 *    (`lines`), which never throws: a failure is its last line.
 *
 * A route may keep its spooled file for a later request instead (the Realm prepare: `keep` on its
 * stream, before the finalizer runs): the finalizer then leaves the staging folder, and the later
 * request imports it with `serveStagedImport` (the Realm commit), which admits it as above (auth, the
 * slot, maintenance, the tracked lifetime) and streams the route's lines from the staged file; its
 * finalizer removes that folder.
 *
 * One memoized finalizer (the file closed, the staging folder removed, the slot released, the
 * lifetime released) runs when a step before the stream fails, before the last line (the generator
 * awaits it, so an import the client starts on reading that line is admitted), when the stream is
 * cancelled, or when the request signal (or the route's `abort`) aborts: the adapter attaches its own close listeners only
 * once it writes the headers, so a request-signal listener returns the generator, whether it never
 * started, waits at a `yield`, or is inside a step (the step ends first; the route's per-step check of
 * the signal stops it).
 */

/**
 * One file import at a time across the routes that share the slot (the module, CharX, and Realm
 * imports: each holds a spooled file and a write loop while it runs; a staged Realm import waiting for
 * its commit does not hold it). The backup import keeps its own.
 */
export type ImportSlot = { busy: boolean };

export function createImportSlot(): ImportSlot {
    return { busy: false };
}

export type FileImportDeps = {
    savePath: string;
    snapshots: SnapshotManager;
    auth: AuthStore;
    maxImportBytes: number;
    slot: ImportSlot;
};

/**
 * What a route's lines get: the spooled file, its staging folder (removed by the finalizer, so a
 * route may stage more files there), the request's signal, the finalizer to await before the last
 * line, and `keep`, which leaves the staging folder to the route (for `serveStagedImport`; call it
 * before the finalizer runs).
 */
export type FileImportStream = {
    handle: FileHandle;
    staging: string;
    signal: AbortSignal;
    finalize: () => Promise<void>;
    keep: () => void;
};

/** A spooled file a route kept (`FileImportStream.keep`): its staging folder, the file in it, and the route's plan. */
export type StagedFile<Plan> = { staging: string; file: string; plan: Plan };

export type StagedImportRoute<Plan> = {
    /**
     * Reads the request (authenticated by then) and finds the staged file it names: a `Response` for a
     * refusal, else `take`, called once the import is admitted (holding the slot, its lifetime
     * tracked), which hands the staged file over: its folder is then the finalizer's to remove.
     */
    find(c: Context<AppEnv>): Promise<{ take(): StagedFile<Plan> } | Response>;
    /** As `FileImportRoute.refusal`. */
    refusal(c: Context<AppEnv>, error: unknown): Response | null;
    /** As `FileImportRoute.lines`. */
    lines(plan: Plan, stream: FileImportStream): AsyncGenerator<Uint8Array>;
};

/**
 * Where a route's file comes from when it is not the request body (the Realm download): the bytes to
 * spool, the cap they are spooled under, what the route's `prepare` needs to know about them, and
 * `cancel`, which stops the source (an upstream body) and is called by the finalizer.
 */
export type FileImportSource<Meta> = {
    body: ReadableStream<Uint8Array>;
    limit: number;
    meta: Meta;
    cancel(): void;
};

export type FileImportRoute<Plan, Meta = undefined> = {
    /** The staging folder's prefix: `<prefix>-<uuid>` under `save/.tmp`. */
    stagingPrefix: string;
    /** The spooled file's name in that folder. */
    fileName: string;
    /** The 400 `error` text for a request without a body (a route with a `source` never sends it). */
    missingBody: string;
    /**
     * A last refusal before admission, after authentication and the slot and maintenance checks:
     * synchronous, so nothing runs between it and the slot being taken. A `Response` refuses the
     * request (the body unread); null admits it.
     */
    preflight?(c: Context<AppEnv>): Response | null;
    /** Aborts the admitted import as the request's own abort does (the upstream import's shutdown). */
    abort?: AbortSignal;
    /**
     * The file's source when it is not the request body: called once the import holds the slot and
     * its lifetime is tracked, before anything is spooled. A `Response` is the answer (a refusal); a
     * throw goes to `refusal`. Without it the request body is the file, under `maxImportBytes` and
     * its declared length.
     */
    source?(c: Context<AppEnv>, signal: AbortSignal): Promise<FileImportSource<Meta> | Response>;
    /** Validates the whole spooled file before anything is written; throws to refuse it. */
    prepare(handle: FileHandle, meta: Meta, signal: AbortSignal): Promise<Plan>;
    /**
     * The answer to an error a step before the stream threw, or null for one the route does not know:
     * a `MaintenanceError` is then a 503 with `Retry-After: 5`, any other error the app's 500.
     */
    refusal(c: Context<AppEnv>, error: unknown): Response | null;
    /** The answer's lines. Never throws (a failure is the last line); awaits `finalize` before the last line. */
    lines(plan: Plan, stream: FileImportStream): AsyncGenerator<Uint8Array>;
};

/** Serves one file import request (see the file comment). Call it after the route's limiter. */
export async function serveFileImport<Plan, Meta = undefined>(
    c: Context<AppEnv>,
    deps: FileImportDeps,
    route: FileImportRoute<Plan, Meta>,
): Promise<Response> {
    const { savePath, snapshots, auth, maxImportBytes, slot } = deps;
    const denied = await auth.checkAuth(c);
    if (denied) {
        return denied;
    }
    if (!route.source) {
        const declared = Number(c.req.header("content-length") ?? "0");
        if (declared > maxImportBytes) {
            return c.json({ error: "File too large" }, 413);
        }
    }
    if (slot.busy) {
        return c.json({ error: "Another import is running" }, 409);
    }
    if (snapshots.gate.active) {
        return refuse(c, new MaintenanceError(), route.refusal);
    }
    const refused = route.preflight?.(c);
    if (refused) {
        return refused;
    }
    const requestBody = c.req.raw.body;
    if (!route.source && !requestBody) {
        return c.json({ error: route.missingBody }, 400);
    }

    const admitted = admit(c, deps, route.refusal, route.abort);
    if (admitted instanceof Response) {
        return admitted;
    }
    const { signal, lifetime } = admitted;

    let file: FileHandle;
    let plan: Plan;
    let stagingFolder: string;
    try {
        stagingFolder = await makeStaging(path.join(savePath, ".tmp"), route.stagingPrefix);
        lifetime.staging = stagingFolder;
        let body: ReadableStream<Uint8Array>;
        let limit = maxImportBytes;
        let meta = undefined as Meta;
        if (route.source) {
            const source = await route.source(c, signal);
            if (source instanceof Response) {
                await lifetime.finalize();
                return source;
            }
            lifetime.cancelSource = () => source.cancel();
            ({ body, limit, meta } = source);
        } else {
            body = requestBody!;
        }
        const spooled = path.join(stagingFolder, route.fileName);
        // The route's own `abort` (shutdown) also stops the upload; without one, the spool ends as the body does.
        if (!(await spool(body, spooled, limit, route.abort ? signal : undefined))) {
            await lifetime.finalize();
            return c.json({ error: "File too large" }, 413);
        }
        file = await fs.open(spooled, "r");
        lifetime.handle = file;
        plan = await route.prepare(file, meta, signal);
    } catch (error) {
        await lifetime.finalize();
        return refuse(c, error, route.refusal);
    }
    return answerLines(c, admitted, route.lines(plan, stream(admitted, file, stagingFolder)));
}

/**
 * Serves the import of a file a route kept from an earlier request (see the file comment; the Realm
 * commit): authenticated, then the route finds the staged file; refused while another import holds
 * the slot (409) or during maintenance (503), the staged file left in place; then, admitted, the file
 * is taken, opened, and streamed through the route's lines, and the finalizer removes its folder.
 */
export async function serveStagedImport<Plan>(
    c: Context<AppEnv>,
    deps: Omit<FileImportDeps, "maxImportBytes">,
    route: StagedImportRoute<Plan>,
): Promise<Response> {
    const denied = await deps.auth.checkAuth(c);
    if (denied) {
        return denied;
    }
    const found = await route.find(c);
    if (found instanceof Response) {
        return found;
    }
    if (deps.slot.busy) {
        return c.json({ error: "Another import is running" }, 409);
    }
    if (deps.snapshots.gate.active) {
        return refuse(c, new MaintenanceError(), route.refusal);
    }
    const admitted = admit(c, deps, route.refusal);
    if (admitted instanceof Response) {
        return admitted;
    }
    const { signal, lifetime } = admitted;
    const staged = found.take();
    lifetime.staging = staged.staging;
    let file: FileHandle;
    try {
        file = await fs.open(staged.file, "r");
        lifetime.handle = file;
    } catch (error) {
        await lifetime.finalize();
        return refuse(c, error, route.refusal);
    }
    return answerLines(c, admitted, route.lines(staged.plan, stream(admitted, file, staged.staging)));
}

/** An admitted import's lifetime: what its finalizer releases, filled in as the import gets it. */
type ImportLifetime = {
    staging: string | null;
    handle: FileHandle | null;
    cancelSource: (() => void) | null;
    kept: boolean;
    finalize: () => Promise<void>;
};

type Admitted = { signal: AbortSignal; cancelled: AbortController; lifetime: ImportLifetime };

/**
 * Admits an import whose refusals before admission were answered: its lifetime tracked (shutdown
 * waits for it; a `Response` once shutdown stopped admissions) and the slot taken. Its signal aborts
 * when the request does, when the answer is cancelled (before the generator is returned, so a step
 * in progress stops at its next check), or when the route's `abort` does. Synchronous, so nothing runs
 * between the caller's slot check and the slot being taken.
 */
function admit(
    c: Context<AppEnv>,
    { snapshots, slot }: Pick<FileImportDeps, "snapshots" | "slot">,
    refusal: (c: Context<AppEnv>, error: unknown) => Response | null,
    abort?: AbortSignal,
): Admitted | Response {
    const cancelled = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, cancelled.signal, ...(abort ? [abort] : [])]);
    let release!: () => void;
    const tracked = new Promise<void>((resolve) => (release = resolve));
    try {
        snapshots.track(() => tracked);
    } catch (error) {
        return refuse(c, error, refusal);
    }
    slot.busy = true;
    let finalized: Promise<void> | null = null;
    const lifetime: ImportLifetime = {
        staging: null,
        handle: null,
        cancelSource: null,
        kept: false,
        finalize: () =>
            (finalized ??= (async () => {
                try {
                    lifetime.cancelSource?.();
                } catch {
                    // The source is stopped as far as it can be.
                }
                await lifetime.handle?.close().catch(() => {});
                if (lifetime.staging && !lifetime.kept) {
                    await fs.rm(lifetime.staging, { recursive: true, force: true }).catch(() => {});
                }
                slot.busy = false;
                release();
            })()),
    };
    return { signal, cancelled, lifetime };
}

/** What the route's lines get (`FileImportStream`) for an admitted import's open file. */
function stream({ signal, lifetime }: Admitted, handle: FileHandle, staging: string): FileImportStream {
    return {
        handle,
        staging,
        signal,
        finalize: lifetime.finalize,
        keep: () => {
            lifetime.kept = true;
        },
    };
}

/**
 * The 200 NDJSON answer streamed from the route's lines (see the file comment), or 400 `Request
 * aborted` when the client is gone already. A request-signal abort returns the generator and runs the
 * finalizer.
 */
function answerLines(
    c: Context<AppEnv>,
    { signal, cancelled, lifetime }: Admitted,
    iterator: AsyncGenerator<Uint8Array>,
): Response | Promise<Response> {
    const { finalize } = lifetime;
    if (signal.aborted) {
        return iterator
            .return(undefined)
            .catch(() => {})
            .then(finalize)
            .then(() => c.json({ error: "Request aborted" }, 400));
    }
    signal.addEventListener(
        "abort",
        () => {
            void iterator
                .return(undefined)
                .catch(() => {})
                .finally(finalize);
        },
        { once: true },
    );
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-store");
    return c.body(
        iteratorStream(iterator, finalize, () => cancelled.abort()),
        200,
    );
}

/** The route's answer to a refusal before the stream started; maintenance is a 503, any other error the app's 500. */
function refuse(
    c: Context<AppEnv>,
    error: unknown,
    refusal: (c: Context<AppEnv>, error: unknown) => Response | null,
): Response {
    const answer = refusal(c, error);
    if (answer) {
        return answer;
    }
    if (error instanceof MaintenanceError) {
        c.header("Retry-After", "5");
        return c.json({ error: error.message }, 503);
    }
    throw error;
}

/** Fills `buffer` from the file at `position`; a file that ends first throws `truncated()`. */
export async function readFileAt(
    handle: FileHandle,
    buffer: Uint8Array,
    position: number,
    truncated: () => Error,
): Promise<Uint8Array> {
    let done = 0;
    while (done < buffer.length) {
        const { bytesRead } = await handle.read(buffer, done, buffer.length - done, position + done);
        if (bytesRead === 0) {
            throw truncated();
        }
        done += bytesRead;
    }
    return buffer;
}
