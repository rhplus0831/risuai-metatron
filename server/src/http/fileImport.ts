import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";
import { MaintenanceError, type SnapshotManager } from "../data/snapshots.ts";
import type { AuthStore } from "../routes/auth.ts";
import type { AppEnv } from "../types.ts";
import { iteratorStream } from "./recordStream.ts";
import { makeStaging, spool } from "./spool.ts";

/**
 * The lifecycle shared by the routes that import one whole file as the raw body and answer NDJSON
 * (historical `docs/plan/large-asset-import.md` slices 2b and 2d): the module import (`routes/importModule.ts`)
 * and the CharX import (`routes/importCharx.ts`). Each route supplies its validation, its refusals,
 * and its lines; `serveFileImport` owns the rest, in this order:
 *
 * 1. Refused before the body is read: authentication, a declared length over `maxImportBytes` (413
 *    `File too large`), another import holding the shared slot (409 `Another import is running`),
 *    maintenance (503 with `Retry-After: 5`), no body (400 with the route's text).
 * 2. The lifetime is tracked (`snapshots.track`; 503 once shutdown stopped admissions), the slot
 *    taken, and the body spooled to `save/.tmp/<prefix>-<uuid>/<fileName>` under `maxImportBytes`
 *    (413 past it), then opened (`fs.open`, read-only) and validated by the route (`prepare`) before
 *    anything is written. A client gone by then is 400 `Request aborted`.
 * 3. The 200 answer is `application/x-ndjson` and `no-store`, streamed from the route's generator
 *    (`lines`), which never throws: a failure is its last line.
 *
 * One memoized finalizer (the file closed, the staging folder removed, the slot released, the
 * lifetime released) runs when a step before the stream fails, before the last line (the generator
 * awaits it, so an import the client starts on reading that line is admitted), when the stream is
 * cancelled, or when the request signal aborts: the adapter attaches its own close listeners only
 * once it writes the headers, so a request-signal listener returns the generator, whether it never
 * started, waits at a `yield`, or is inside a step (the step ends first; the route's per-step check of
 * the signal stops it).
 */

/**
 * One file import at a time across the routes that share the slot (the module and CharX imports:
 * each holds a spooled file and a write loop). The backup import keeps its own.
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

/** What a route's lines get: the spooled file, the request's signal, and the finalizer to await before the last line. */
export type FileImportStream = {
    handle: FileHandle;
    signal: AbortSignal;
    finalize: () => Promise<void>;
};

export type FileImportRoute<Plan> = {
    /** The staging folder's prefix: `<prefix>-<uuid>` under `save/.tmp`. */
    stagingPrefix: string;
    /** The spooled file's name in that folder. */
    fileName: string;
    /** The 400 `error` text for a request without a body. */
    missingBody: string;
    /** Validates the whole spooled file before anything is written; throws to refuse it. */
    prepare(handle: FileHandle): Promise<Plan>;
    /**
     * The answer to an error a step before the stream threw, or null for one the route does not know:
     * a `MaintenanceError` is then a 503 with `Retry-After: 5`, any other error the app's 500.
     */
    refusal(c: Context<AppEnv>, error: unknown): Response | null;
    /** The answer's lines. Never throws (a failure is the last line); awaits `finalize` before the last line. */
    lines(plan: Plan, stream: FileImportStream): AsyncGenerator<Uint8Array>;
};

/** Serves one file import request (see the file comment). Call it after the route's limiter. */
export async function serveFileImport<Plan>(
    c: Context<AppEnv>,
    deps: FileImportDeps,
    route: FileImportRoute<Plan>,
): Promise<Response> {
    const { savePath, snapshots, auth, maxImportBytes, slot } = deps;
    const denied = await auth.checkAuth(c);
    if (denied) {
        return denied;
    }
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > maxImportBytes) {
        return c.json({ error: "File too large" }, 413);
    }
    if (slot.busy) {
        return c.json({ error: "Another import is running" }, 409);
    }
    if (snapshots.gate.active) {
        return refuse(c, new MaintenanceError(), route);
    }
    const body = c.req.raw.body;
    if (!body) {
        return c.json({ error: route.missingBody }, 400);
    }

    // The import's lifetime (spool, validation, and stream) is tracked, so shutdown waits for it.
    const signal = c.req.raw.signal;
    let release!: () => void;
    const lifetime = new Promise<void>((resolve) => (release = resolve));
    try {
        snapshots.track(() => lifetime);
    } catch (error) {
        return refuse(c, error, route);
    }
    slot.busy = true;
    let staging: string | null = null;
    let handle: FileHandle | null = null;
    let finalized: Promise<void> | null = null;
    const finalize = () =>
        (finalized ??= (async () => {
            await handle?.close().catch(() => {});
            if (staging) {
                await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
            }
            slot.busy = false;
            release();
        })());

    let file: FileHandle;
    let plan: Plan;
    try {
        staging = await makeStaging(path.join(savePath, ".tmp"), route.stagingPrefix);
        const spooled = path.join(staging, route.fileName);
        if (!(await spool(body, spooled, maxImportBytes))) {
            await finalize();
            return c.json({ error: "File too large" }, 413);
        }
        file = await fs.open(spooled, "r");
        handle = file;
        plan = await route.prepare(file);
    } catch (error) {
        await finalize();
        return refuse(c, error, route);
    }
    if (signal.aborted) {
        await finalize();
        return c.json({ error: "Request aborted" }, 400);
    }

    const iterator = route.lines(plan, { handle: file, signal, finalize });
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
    return c.body(iteratorStream(iterator, finalize), 200);
}

/** The route's answer to a refusal before the stream started; maintenance is a 503, any other error the app's 500. */
function refuse<Plan>(c: Context<AppEnv>, error: unknown, route: FileImportRoute<Plan>): Response {
    const answer = route.refusal(c, error);
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
