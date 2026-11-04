import { randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    fsyncSync,
    ftruncateSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import fsPromises, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
    type DiagnosticEvent,
    type DiagnosticEventInput,
    type DiagnosticsState,
    isDiagnosticErrorEvent,
    isJobFailureEvent,
    projectDiagnosticEvent,
    projectServerEvent,
} from "../../../shared/diagnostics.ts";
import { BUILD_ID_PATTERN } from "../../../shared/buildInfo.ts";
import { MAX_DIAGNOSTIC_REPORT_BYTES, REPORT_FILE_PATTERN } from "../../../shared/diagnosticsReport.ts";
import {
    type RequestHistoryShareEntry,
    type RequestHistoryShareTarget,
    SHARE_JOB_ID,
    SHARE_REQUEST_ID,
} from "../../../shared/requestHistory.ts";
import { syncDir, syncDirSync } from "../data/durableWrite.ts";
import { createOrderedWriter, type OrderedWriter } from "../data/orderedWriter.ts";
import type { DiagnosticsRecorder } from "./log.ts";

/** `RISU_DIAGNOSTICS_MAX_BYTES`' default: the cap of `events/`. */
export const DIAGNOSTICS_MAX_BYTES = 64 * 1024 * 1024;

/** `maxQueuedBytes`' default: the bytes of event lines waiting for the disk. */
export const MAX_QUEUED_WRITE_BYTES = 8 * 1024 * 1024;

const RING_SIZE = 300;
const RECENT_JOB_FAILURES = 20;
const STATE_INTERVAL_MS = 10 * 60_000;
const STATE_DELAY_MS = 5_000;
const DRAIN_DEADLINE_MS = 1_000;
const EVENTS_KEY = "diagnostics:events";
const STATE_KEY = "diagnostics:state";
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const STATE_FILE = "state.json";
const REPORTS_KEPT = 50;
/** A shared copy: `<UTC stamp to the ms>-job-<job id>.json` or `<stamp>-request-<request id>.json`. */
const SHARE_FILE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-(job|request)-([A-Za-z0-9-]{1,80})\.json$/;
/** A shared copy being written: `.share-<kind>-<id>-<8 hex>.tmp`. */
const SHARE_TEMP = /^\.share-(job|request)-([A-Za-z0-9-]{1,80})-[0-9a-f]{8}\.tmp$/;
/** The longest event line `eventsFor` reads; a longer one is skipped (no event the journal writes is near it). */
const MAX_EVENT_LINE = 64 * 1024;
const READ_CHUNK = 64 * 1024;
const DIR_MODE = 0o750;
const FILE_MODE = 0o640;
/** Not defined on Windows: there the open does not protect the final component (the `lstat` before it remains). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const APPEND_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | NOFOLLOW | NONBLOCK;
const TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;

/** The `node:fs/promises` file handle members the queued writes call. */
export type JournalFileHandle = Pick<FileHandle, "fd" | "stat" | "read" | "write" | "chmod" | "sync" | "close">;

/** The `node:fs/promises` members the queued writes call (tests inject latency and failures). */
export type JournalFs = {
    open(file: string, flags: string | number, mode?: number): Promise<JournalFileHandle>;
    lstat(file: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    mkdir(folder: string, options: { mode: number }): Promise<unknown>;
    chmod(file: string, mode: number): Promise<void>;
};

/** What `state.json` reports besides the journal's own fields; each source is read on its own. */
export type DiagnosticsStateSources = {
    appVersion?: () => unknown;
    /** The server's build id (`shared/buildInfo.ts` `formatBuildId`). */
    appBuild?: () => unknown;
    settings?: () => { requestHistoryContent: unknown; requestHistoryLimit: unknown };
    history?: () => { rows: unknown; bytes: unknown };
    workers?: () => Record<string, unknown>;
    liveJobs?: () => unknown;
};

/** The server's checked event journal, state publications, reports, and explicit support copies. */
export type DiagnosticsJournal = DiagnosticsRecorder & {
    /** The ring (the last 300 events), oldest first, as copies. */
    recent(): DiagnosticEvent[];
    /** The state `state.json` would hold now. */
    state(): DiagnosticsState;
    /**
     * Queues a `state.json` publication (temp file, then rename) and resolves when it ended. One queued
     * and not yet started is shared, and builds its state when it starts. Past the fence it publishes
     * synchronously. Never rejects: a failure is counted.
     */
    writeState(): Promise<void>;
    /** Publishes `state.json` before it returns (the boot state: nothing is served yet). */
    writeStateSync(): void;
    /**
     * A fault that ends the process: raises the fence, then appends what is still queued and the fault's
     * event, and publishes the state, all before it returns. Both fatal paths in `server/src/main.ts`
     * call this: the uncaught-exception monitor and the HTTP server's error handler.
     */
    recordFatal(input: DiagnosticEventInput): void;
    /** Waits for earlier queued appends to finish, without guaranteeing their retention; immediate past the fence. */
    settled(): Promise<void>;
    /** Starts the 10-minute `state.json` timer. Idempotent. */
    start(): void;
    /** Stops the timers and the state writes they would make; `record` and `writeState` still work. Idempotent. */
    close(): void;
    /**
     * The end of a graceful shutdown: closes the timers, waits for both event and state queue keys
     * (at most `drainDeadlineMs`, default 1 s), then raises the fence as `recordFatal` does and
     * publishes the final state after the takeover's writes. Idempotent.
     */
    finish(): Promise<void>;
    stats(): { eventBytes: number; writeFailures: number; dropped: number };
    /** Saves a checked report to `reports/` (newest 50 kept). Never throws: a failure is counted. */
    saveReport(text: string): SaveReportResult;
    /**
     * The server events `match` accepts, from the day files of `fromMs`'s UTC day (an hour before it)
     * on, and the ring; oldest first. `partial` when a day file or `events/` could not be read, a line
     * was skipped, or the queue cap dropped an append in that interval. An append still queued is read
     * from the ring; await `settled` first to finish earlier queued appends. Dropped or failed writes
     * no longer in the ring can leave gaps. Never throws.
     */
    eventsFor(
        match: (event: DiagnosticEvent) => boolean,
        fromMs: number,
    ): { events: DiagnosticEvent[]; partial: boolean };
    /**
     * Writes a shared copy (`chunks`, in order) to `shared/` as a new file of the target, beside its
     * older ones (`commitShare` removes those once the share is recorded, `discardShare` this one when
     * it is not), named by `at` (default now). Never throws: a failure is counted.
     */
    saveShare(target: RequestHistoryShareTarget, chunks: Iterable<string>, at?: number): SaveReportResult;
    /** Removes the target's other copies (and abandoned temp files), keeping `keep`. Whether every one is gone. */
    commitShare(target: RequestHistoryShareTarget, keep: string): boolean;
    /** Removes one copy `saveShare` wrote. Whether it is gone. */
    discardShare(name: string): boolean;
    /** Removes every copy (and temp file) of the target. Whether every one is gone (an absent `shared/` is). */
    removeShares(target: RequestHistoryShareTarget): boolean;
    /** Removes every copy and temp file in `shared/`. Whether every one is gone. */
    removeAllShares(): boolean;
    /** The targets with a copy, newest first (the newest copy's time), or null when `shared/` could not be read. */
    listShares(): RequestHistoryShareEntry[] | null;
};

export type SaveReportResult = { ok: true; name: string } | { ok: false };

type ShareFile = { name: string; target: RequestHistoryShareTarget; at: number };

/** An event line waiting for the disk. */
type QueuedLine = { name: string; line: string; bytes: number };

/** The target of a share kind and id, or null when the id is not of the server's shapes. */
function shareTarget(kind: string, id: string): RequestHistoryShareTarget | null {
    if (kind === "job") {
        return SHARE_JOB_ID.test(id) ? { jobId: id, requestId: null } : null;
    }
    return kind === "request" && SHARE_REQUEST_ID.test(id) ? { jobId: null, requestId: id } : null;
}

/** The file-name part of a target (`job-<id>` or `request-<id>`), or null when its id is not of the server's shapes. */
function shareKey(target: RequestHistoryShareTarget): string | null {
    if (target.jobId !== null) {
        return SHARE_JOB_ID.test(target.jobId) ? `job-${target.jobId}` : null;
    }
    return typeof target.requestId === "string" && SHARE_REQUEST_ID.test(target.requestId)
        ? `request-${target.requestId}`
        : null;
}

function sameTarget(a: RequestHistoryShareTarget, b: RequestHistoryShareTarget): boolean {
    return a.jobId === b.jobId && a.requestId === b.requestId;
}

function parseShareFile(name: string): ShareFile | null {
    const match = SHARE_FILE.exec(name);
    if (!match) {
        return null;
    }
    const target = shareTarget(match[8], match[9]);
    const at = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +match[7]);
    return target && Number.isFinite(at) ? { name, target, at } : null;
}

function parseShareTemp(name: string): RequestHistoryShareTarget | null {
    const match = SHARE_TEMP.exec(name);
    return match ? shareTarget(match[1], match[2]) : null;
}

const APP_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const ERROR_CODE = /^E[A-Z0-9]{1,15}$/;

const isCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const countOrNull = (value: unknown): number | null => (isCount(value) ? value : null);

/** One section of the state, or null when its source is missing or throws. */
function section<T>(read: (() => T) | undefined): T | null {
    if (!read) {
        return null;
    }
    try {
        return read();
    } catch {
        return null;
    }
}

class RefusedPathError extends Error {
    readonly code = "ESYMLINK";
}

/**
 * The server's diagnostics folder: `events/YYYY-MM-DD.jsonl` (one projected event per line, the UTC
 * day of its time), `state.json`, `reports/`, and `shared/`. Content-free: every event goes through
 * `projectDiagnosticEvent`, and the state is built from explicit, checked fields.
 *
 * - `events/` is capped at `maxBytes`: past it, the oldest day file is deleted, the current one too
 *   when it alone passes the cap (the next event starts it again). Only `YYYY-MM-DD.jsonl` regular
 *   files are counted and deleted; anything else in the folder is left alone. The cap is enforced at
 *   creation and after every queued append.
 * - `state.json` is written at creation of the server context (the caller's `writeStateSync`), every
 *   10 minutes (`start`), when a publication queued at most 5 s after an error event ends
 *   (`isDiagnosticErrorEvent`; a pending write is not postponed by later ones), and when the caller
 *   asks (`writeState`; `recordFatal` and `finish` publish the final state).
 * - Appends and `state.json` publications leave the serving thread: `record` and `writeState` queue
 *   them on `writer`, one key each, over `fs`. An append and the prune after it are one operation, so
 *   an append never races the deletion of its file. A line that would take the queued bytes past
 *   `maxQueuedBytes` is not queued: the event stays in the ring and is counted (`dropped`), and
 *   `eventsFor` calls that interval partial. A publication not yet started is shared by later calls and
 *   builds its state when it starts, so the latest state wins.
 * - The fence: `recordFatal` and `finish` raise `terminal` and take over on the calling stack. What
 *   is queued is appended synchronously in order, a fault's event after it, and the state is published,
 *   so all of it lands before the process ends. Past the fence, a queued operation does nothing, one in
 *   flight stops at its next check without updating event-file byte totals, and `record` and
 *   `writeState` work synchronously. Late I/O errors can still increment `writeFailures`.
 *   The synchronous path never prunes: a prune could delete the fault's event when its
 *   day file alone passes the cap (the next creation's scan prunes). Every step that can undo or
 *   replace bytes on disk (a partial append's truncation, a prune's unlink, the publishing rename) runs
 *   on the JS thread behind that check, never as a submitted call, which could land after the
 *   takeover's own writes. A publication stopped by the fence attempts to remove its temp file;
 *   failed cleanup is counted and may leave it behind. A line whose first write was already submitted
 *   at the fence is never replayed by takeover; the outstanding write may complete after the fault's
 *   event or leave an incomplete line.
 * - Reports and shared copies stay synchronous (`writeAtomic`): a share runs as one synchronous step
 *   (`share.ts`), and making them asynchronous would take a queue across a whole share.
 * - Trust: the folder is the server's own; a group may read it. New directories and files use
 *   0750/0640; an existing empty day file also gets 0640 on append. Other existing entries keep their
 *   modes. Inside it nothing is followed: a symlinked or non-directory `events/` stops every operation
 *   below it. A non-regular day file is refused (`lstat`, then `O_NOFOLLOW | O_NONBLOCK` and `fstat`, on both append
 *   paths), and a symlink at `state.json` is replaced by the rename, not followed. The folder itself
 *   may be a symlink (a mount). This guards against a stray entry, not against a writer racing the
 *   server in its own folder.
 * - `reports/` holds the reports the Diagnostics panel saves (`saveReport`): each written
 *   whole (temp file, then rename), the newest 50 kept (after a save, and at creation). The same
 *   refusals apply: a symlinked or non-directory `reports/` is not used, and only report-named
 *   regular files are counted and deleted.
 * - `shared/` holds the copies a user shared for support (`diagnostics/share.ts`): the only
 *   content in the folder, there because the user asked. `saveShare` writes a copy whole (temp file
 *   `.share-<kind>-<id>-<8 hex>.tmp`, then a rename to `<UTC stamp>-<kind>-<id>.json`) beside the
 *   target's older ones, which `commitShare` removes once the share is recorded; `removeShares` and
 *   `removeAllShares` remove copies and their temp files. Only regular files of those two name
 *   patterns, with an id of the server's shapes, are counted, listed, or deleted; a temp file left by
 *   a process that ended mid-write is removed at creation. The same trust model and refusals as
 *   `reports/` apply (a symlinked or non-directory `shared/` is refused, and nothing is removed
 *   through it). The state counts the copies (`shared.files`, null when `shared/` cannot be read)
 *   and is written after every change of them.
 * - `eventsFor` reads the day files back (bounded chunks, a line over 64 KiB skipped, each line
 *   projected again) for a share's events. Refused entries, failed reads, oversized or malformed
 *   lines, unterminated tails, and a drop in the interval mark the result partial.
 * - A failed write never fails the caller: it is counted (`writeFailures`, in the next state that
 *   lands) and the first one is logged with its error code only.
 */
export function createDiagnosticsJournal(options: {
    dir: string;
    maxBytes?: number;
    now?: () => number;
    sources?: DiagnosticsStateSources;
    stateIntervalMs?: number;
    stateDelayMs?: number;
    /** The server context's writer; default one of its own. */
    writer?: OrderedWriter;
    /** What the queued writes call; default `node:fs/promises`. */
    fs?: JournalFs;
    /** The bytes of event lines that may wait for the disk; default `MAX_QUEUED_WRITE_BYTES`. */
    maxQueuedBytes?: number;
    /** How long `finish` waits for the queues; default 1 s. */
    drainDeadlineMs?: number;
}): DiagnosticsJournal {
    const dir = options.dir;
    const eventsDir = path.join(dir, "events");
    const reportsDir = path.join(dir, "reports");
    const sharedDir = path.join(dir, "shared");
    const maxBytes = options.maxBytes ?? DIAGNOSTICS_MAX_BYTES;
    const now = options.now ?? Date.now;
    const sources = options.sources ?? {};
    const writer = options.writer ?? createOrderedWriter();
    const fs = options.fs ?? fsPromises;
    const maxQueuedBytes = options.maxQueuedBytes ?? MAX_QUEUED_WRITE_BYTES;
    const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
    const ring: DiagnosticEvent[] = [];
    const jobFailures: DiagnosticEvent[] = [];
    /** Day file name → its bytes. */
    const files = new Map<string, number>();
    /** The lines whose operation has not started, in order. */
    const pending: QueuedLine[] = [];
    /** The line of the running operation until its first write is submitted: the takeover writes it then. */
    let unwritten: QueuedLine | null = null;
    /** `pending` and the running operation's line. */
    let queuedBytes = 0;
    let eventBytes = 0;
    let writeFailures = 0;
    let dropped = 0;
    /** The time of the last event the queue cap dropped. */
    let lastDropAt: number | null = null;
    /** The copies in `shared/`, null when it could not be read. */
    let sharedFiles: number | null = 0;
    let warned = false;
    let closed = false;
    /** The fence: see `createDiagnosticsJournal`. Never lowered. */
    let terminal = false;
    /** The publication queued and not yet started. */
    let nextPublication: Promise<void> | null = null;
    let finishing: Promise<void> | null = null;
    let stateTimer: ReturnType<typeof setTimeout> | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    function fail(error: unknown) {
        writeFailures++;
        if (warned) {
            return;
        }
        warned = true;
        try {
            const code = (error as { code?: unknown } | null)?.code;
            console.warn(
                "[Diagnostics] Could not write the diagnostics folder:",
                typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown",
            );
        } catch {}
    }

    /** Whether a failure is the path's absence (no failure to count: a delete or a cleanup found nothing). */
    const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

    function closeFd(fd: number) {
        try {
            closeSync(fd);
        } catch (error) {
            fail(error);
        }
    }

    async function closeQueued(handle: JournalFileHandle) {
        try {
            await handle.close();
        } catch (error) {
            fail(error);
        }
    }

    /** Attempts to remove a temp file; failure is counted and may leave it behind, but absence is no failure. */
    function removeTemp(temp: string) {
        try {
            unlinkSync(temp);
        } catch (error) {
            if (!isMissing(error)) {
                fail(error);
            }
        }
    }

    /**
     * Whether a folder of the journal (`events/`, `reports/`) can be used: a real directory, created
     * (0750) when missing and `create` says so. A symlink or any other entry there is refused, and
     * nothing below it is touched (no append, no resync, no prune, no save).
     */
    function folderReady(folder: string, create: boolean): boolean {
        try {
            const stat = lstatSync(folder);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                fail(new RefusedPathError("Not a directory"));
                return false;
            }
            return true;
        } catch (error) {
            if (!isMissing(error)) {
                fail(error);
                return false;
            }
        }
        if (!create) {
            return false;
        }
        try {
            mkdirSync(folder, { mode: DIR_MODE });
            chmodSync(folder, DIR_MODE);
            return true;
        } catch (error) {
            fail(error);
            return false;
        }
    }

    const eventsReady = (create: boolean) => folderReady(eventsDir, create);

    /** `folderReady` over `fs`, for a queued operation (which checks the fence after it). */
    async function folderReadyQueued(folder: string, create: boolean): Promise<boolean> {
        try {
            const stat = await fs.lstat(folder);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                fail(new RefusedPathError("Not a directory"));
                return false;
            }
            return true;
        } catch (error) {
            if (!isMissing(error)) {
                fail(error);
                return false;
            }
        }
        if (!create) {
            return false;
        }
        try {
            await fs.mkdir(folder, { mode: DIR_MODE });
            await fs.chmod(folder, DIR_MODE);
            return true;
        } catch (error) {
            fail(error);
            return false;
        }
    }

    const noProgress = () => Object.assign(new Error("No progress"), { code: "EIO" });

    /** Writes all of `bytes` to `fd`; a write that makes no progress is a failure. */
    function writeAll(fd: number, bytes: Buffer) {
        let offset = 0;
        while (offset < bytes.length) {
            const written = writeSync(fd, bytes, offset, bytes.length - offset);
            if (written <= 0) {
                throw noProgress();
            }
            offset += written;
        }
    }

    /** `writeAll` over `fs`. Past the fence it submits no further write. */
    async function writeAllQueued(handle: JournalFileHandle, bytes: Buffer) {
        let offset = 0;
        while (offset < bytes.length && !terminal) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
            if (bytesWritten <= 0) {
                throw noProgress();
            }
            offset += bytesWritten;
        }
    }

    function setFileBytes(name: string, bytes: number) {
        eventBytes += bytes - (files.get(name) ?? 0);
        files.set(name, bytes);
    }

    function forget(name: string) {
        eventBytes -= files.get(name) ?? 0;
        files.delete(name);
    }

    /**
     * Appends one line to a day file. Before the open, an existing entry that is not a regular file (a
     * symlink, a FIFO) is refused; the open adds `O_NOFOLLOW` and `O_NONBLOCK` (an entry swapped in
     * between), and `fstat` checks again. A file whose last byte is not a newline (an append cut
     * short, here or by an earlier process) gets one first, so the new line parses. A failed write
     * is truncated back where it can be; the count follows the file. Daily event appends are not
     * flushed to disk, so power loss may lose recent lines.
     */
    function appendSync(name: string, line: string) {
        if (!eventsReady(true)) {
            return;
        }
        const file = path.join(eventsDir, name);
        try {
            if (!lstatSync(file).isFile()) {
                fail(new RefusedPathError("Not a file"));
                return;
            }
        } catch (error) {
            if (!isMissing(error)) {
                fail(error);
                return;
            }
        }
        let fd = -1;
        let size = -1;
        try {
            fd = openSync(file, APPEND_FLAGS, FILE_MODE);
            const stat = fstatSync(fd);
            if (!stat.isFile()) {
                throw new RefusedPathError("Not a file");
            }
            size = stat.size;
            if (size === 0) {
                fchmodSync(fd, FILE_MODE);
            }
            let prefix = "";
            if (size > 0) {
                const last = Buffer.alloc(1);
                if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) {
                    prefix = "\n";
                }
            }
            const bytes = Buffer.from(prefix + line, "utf8");
            try {
                writeAll(fd, bytes);
            } catch (error) {
                try {
                    ftruncateSync(fd, size);
                } catch {}
                throw error;
            }
            setFileBytes(name, size + bytes.length);
        } catch (error) {
            fail(error);
            if (fd >= 0) {
                try {
                    setFileBytes(name, fstatSync(fd).size);
                } catch {}
            } else if (isMissing(error)) {
                forget(name);
            }
        } finally {
            if (fd >= 0) {
                closeFd(fd);
            }
        }
    }

    /**
     * `appendSync` over `fs`, for a queued operation: the same refusals, newline repair, complete
     * writes, truncation, and count. The line is the takeover's until its first write is submitted;
     * after that, takeover never replays it. The outstanding write may complete late or leave an
     * incomplete line. After the next fence check, no further write or truncation is submitted and
     * event-file byte totals no longer change; a late I/O error is still counted.
     */
    async function appendQueued(name: string, line: string) {
        if (!(await folderReadyQueued(eventsDir, true)) || terminal) {
            return;
        }
        const file = path.join(eventsDir, name);
        try {
            if (!(await fs.lstat(file)).isFile()) {
                fail(new RefusedPathError("Not a file"));
                return;
            }
        } catch (error) {
            if (!isMissing(error)) {
                fail(error);
                return;
            }
        }
        if (terminal) {
            return;
        }
        let handle: JournalFileHandle | null = null;
        try {
            handle = await fs.open(file, APPEND_FLAGS, FILE_MODE);
            const stat = await handle.stat();
            if (!stat.isFile()) {
                throw new RefusedPathError("Not a file");
            }
            const size = stat.size;
            if (size === 0) {
                await handle.chmod(FILE_MODE);
            }
            let prefix = "";
            if (size > 0) {
                const last = Buffer.alloc(1);
                const { bytesRead } = await handle.read(last, 0, 1, size - 1);
                if (bytesRead === 1 && last[0] !== 0x0a) {
                    prefix = "\n";
                }
            }
            if (terminal) {
                return;
            }
            const bytes = Buffer.from(prefix + line, "utf8");
            unwritten = null;
            try {
                await writeAllQueued(handle, bytes);
            } catch (error) {
                if (!terminal) {
                    try {
                        ftruncateSync(handle.fd, size);
                    } catch {}
                }
                throw error;
            }
            if (!terminal) {
                setFileBytes(name, size + bytes.length);
            }
        } catch (error) {
            fail(error);
            if (handle) {
                try {
                    const { size } = await handle.stat();
                    if (!terminal) {
                        setFileBytes(name, size);
                    }
                } catch {}
            } else if (isMissing(error) && !terminal) {
                forget(name);
            }
        } finally {
            if (handle) {
                await closeQueued(handle);
            }
        }
    }

    /** One queued line: its append, then the prune, in one operation, so the two never race. */
    async function appendNext() {
        const entry = pending.shift();
        if (!entry) {
            return;
        }
        unwritten = entry;
        try {
            await appendQueued(entry.name, entry.line);
            unwritten = null;
            await pruneQueued();
        } finally {
            queuedBytes -= entry.bytes;
        }
    }

    /** Queues an accepted event's line; at the cap it is counted instead (the ring keeps the event). */
    function queueLine(name: string, line: string, at: number) {
        const bytes = Buffer.byteLength(line, "utf8");
        if (queuedBytes + bytes > maxQueuedBytes) {
            dropped++;
            lastDropAt = at;
            return;
        }
        queuedBytes += bytes;
        pending.push({ name, line, bytes });
        void writer.run(EVENTS_KEY, appendNext).catch(fail);
    }

    /** Raises the fence and appends what is still queued, in order. No prune: see `createDiagnosticsJournal`. */
    function takeOver() {
        terminal = true;
        close();
        const lines = unwritten ? [unwritten, ...pending] : [...pending];
        unwritten = null;
        pending.length = 0;
        for (const { name, line } of lines) {
            appendSync(name, line);
        }
    }

    /**
     * Deletes the oldest day files while `events/` passes the cap; stops at a deletion that fails
     * (a file already gone counts as deleted).
     */
    function deleteOldest() {
        while (eventBytes > maxBytes && files.size > 0) {
            const oldest = [...files.keys()].sort()[0];
            try {
                unlinkSync(path.join(eventsDir, oldest));
            } catch (error) {
                if (!isMissing(error)) {
                    fail(error);
                    return;
                }
            }
            forget(oldest);
        }
    }

    /** Nothing is deleted through a refused `events/`. */
    function prune() {
        if (eventBytes > maxBytes && eventsReady(false)) {
            deleteOldest();
        }
    }

    /** `prune` for a queued operation: the unlinks run on the JS thread, behind the fence. */
    async function pruneQueued() {
        if (eventBytes > maxBytes && (await folderReadyQueued(eventsDir, false)) && !terminal) {
            deleteOldest();
        }
    }

    function scan() {
        try {
            if (mkdirSync(dir, { recursive: true, mode: DIR_MODE }) !== undefined) {
                chmodSync(dir, DIR_MODE);
            }
        } catch (error) {
            fail(error);
            return;
        }
        if (eventsReady(true)) {
            try {
                for (const entry of readdirSync(eventsDir, { withFileTypes: true })) {
                    if (entry.isFile() && DAY_FILE.test(entry.name)) {
                        try {
                            setFileBytes(entry.name, lstatSync(path.join(eventsDir, entry.name)).size);
                        } catch (error) {
                            if (!isMissing(error)) {
                                fail(error);
                            }
                        }
                    }
                }
            } catch (error) {
                fail(error);
            }
            prune();
        }
        // A save cut short between its rename and its prune leaves one too many.
        pruneReports(null);
        // A share cut short (the process ended while it wrote) leaves its temp file.
        removeShareEntries(() => false, true);
    }

    /**
     * Deletes the oldest reports (by name, so by save time) past the newest `REPORTS_KEPT`, never
     * `keep` (the report just saved, whatever the clock did). Only `REPORT_FILE_PATTERN` regular files
     * count; nothing is opened. Stops at a deletion that fails (one already gone counts as deleted).
     */
    function pruneReports(keep: string | null) {
        if (!folderReady(reportsDir, false)) {
            return;
        }
        let names: string[];
        try {
            names = readdirSync(reportsDir, { withFileTypes: true })
                .filter((entry) => entry.isFile() && REPORT_FILE_PATTERN.test(entry.name))
                .map((entry) => entry.name)
                .sort();
        } catch (error) {
            fail(error);
            return;
        }
        let excess = names.length - REPORTS_KEPT;
        for (const name of names) {
            if (excess <= 0) {
                break;
            }
            if (name === keep) {
                continue;
            }
            try {
                unlinkSync(path.join(reportsDir, name));
            } catch (error) {
                if (!isMissing(error)) {
                    fail(error);
                    return;
                }
            }
            excess--;
        }
    }

    const tempPath = (folder: string, prefix: string) =>
        path.join(folder, `.${prefix}-${randomBytes(4).toString("hex")}.tmp`);

    /**
     * Writes `text` (or its chunks, in order) to `target` in `folder`: a temp file there
     * (`O_EXCL | O_NOFOLLOW`, 0640), flushed before close, then a rename and directory sync. Whether
     * it landed; a failure (a chunk that throws included) is counted. If this call made a temp file,
     * it attempts cleanup; a cleanup failure is counted and may leave that file behind.
     * A directory sync failure propagated by `server/src/data/durableWrite.ts` is
     * counted but still returns true: the file landed. That helper tolerates EINVAL/EPERM from opening
     * or syncing the directory on filesystems that refuse directory flushes.
     */
    function writeAtomic(folder: string, target: string, text: string | Iterable<string>, tempPrefix: string): boolean {
        let temp: string | null = null;
        let fd = -1;
        try {
            const name = tempPath(folder, tempPrefix);
            fd = openSync(name, TEMP_FLAGS, FILE_MODE);
            temp = name;
            fchmodSync(fd, FILE_MODE);
            for (const chunk of typeof text === "string" ? [text] : text) {
                writeAll(fd, Buffer.from(chunk, "utf8"));
            }
            fsyncSync(fd);
            const opened = fd;
            fd = -1;
            closeSync(opened);
            renameSync(temp, target);
            temp = null;
            try {
                syncDirSync(folder);
            } catch (error) {
                fail(error);
            }
            return true;
        } catch (error) {
            fail(error);
            return false;
        } finally {
            if (fd >= 0) {
                closeFd(fd);
            }
            if (temp !== null) {
                removeTemp(temp);
            }
        }
    }

    /**
     * Saves a report (the caller checked it: `canonicalDiagnosticReport`) as
     * `reports/<UTC stamp>-<8 hex>.txt`, then keeps the newest 50. A name already taken is drawn
     * again (a stray entry, not a racing writer: the rename would replace one created between the
     * check and the rename). A prune that fails after the save does not undo it. Never throws.
     */
    function saveReport(text: string): SaveReportResult {
        try {
            if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_DIAGNOSTIC_REPORT_BYTES) {
                return { ok: false };
            }
            if (!folderReady(reportsDir, true)) {
                return { ok: false };
            }
            const stamp = new Date(now()).toISOString().replace(/[-:.]/g, "");
            for (let attempt = 0; attempt < 3; attempt++) {
                const name = `${stamp}-${randomBytes(4).toString("hex")}.txt`;
                const file = path.join(reportsDir, name);
                try {
                    lstatSync(file);
                    continue;
                } catch (error) {
                    if (!isMissing(error)) {
                        fail(error);
                        return { ok: false };
                    }
                }
                if (!REPORT_FILE_PATTERN.test(name) || !writeAtomic(reportsDir, file, text, "report")) {
                    return { ok: false };
                }
                pruneReports(name);
                return { ok: true, name };
            }
            fail(Object.assign(new Error("Every name drawn was taken"), { code: "EEXIST" }));
            return { ok: false };
        } catch (error) {
            fail(error);
            return { ok: false };
        }
    }

    /**
     * `shared/`'s copies and temp files (regular files of their name patterns only): an empty
     * listing when it does not exist, null when it is refused (a symlink, not a directory) or
     * unreadable (counted).
     */
    function shareEntries(): {
        files: ShareFile[];
        temps: { name: string; target: RequestHistoryShareTarget }[];
    } | null {
        try {
            const stat = lstatSync(sharedDir);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                fail(new RefusedPathError("Not a directory"));
                return null;
            }
        } catch (error) {
            if (isMissing(error)) {
                return { files: [], temps: [] };
            }
            fail(error);
            return null;
        }
        try {
            const files: ShareFile[] = [];
            const temps: { name: string; target: RequestHistoryShareTarget }[] = [];
            for (const entry of readdirSync(sharedDir, { withFileTypes: true })) {
                if (!entry.isFile()) {
                    continue;
                }
                const file = parseShareFile(entry.name);
                if (file) {
                    files.push(file);
                    continue;
                }
                const temp = parseShareTemp(entry.name);
                if (temp) {
                    temps.push({ name: entry.name, target: temp });
                }
            }
            return { files, temps };
        } catch (error) {
            fail(error);
            return null;
        }
    }

    /** Counts the copies again (null when `shared/` could not be read). */
    function recountShares(listing = shareEntries()) {
        sharedFiles = listing ? listing.files.length : null;
    }

    /** Deletes one entry of `shared/`; whether it is gone. */
    function unlinkShare(name: string): boolean {
        try {
            unlinkSync(path.join(sharedDir, name));
            return true;
        } catch (error) {
            if (isMissing(error)) {
                return true;
            }
            fail(error);
            return false;
        }
    }

    /**
     * Deletes the copies `drop` accepts, and the temp files `temps` accepts (every one when
     * `allTemps`). Whether every one is gone (none can be when `shared/` is refused or unreadable);
     * the count is taken again.
     */
    function removeShareEntries(
        drop: (file: ShareFile) => boolean,
        allTemps: boolean,
        temps?: (target: RequestHistoryShareTarget) => boolean,
    ): boolean {
        const listing = shareEntries();
        if (!listing) {
            sharedFiles = null;
            return false;
        }
        let ok = true;
        for (const file of listing.files) {
            if (drop(file) && !unlinkShare(file.name)) {
                ok = false;
            }
        }
        for (const temp of listing.temps) {
            if (allTemps || temps?.(temp.target)) {
                if (!unlinkShare(temp.name)) {
                    ok = false;
                }
            }
        }
        recountShares();
        return ok;
    }

    /**
     * Saves a shared copy as `shared/<UTC stamp>-<kind>-<id>.json` (temp file `.share-<kind>-<id>-<8
     * hex>.tmp`, then a rename). A name already taken (a share of the same target in the same
     * millisecond) moves the stamp on, so an older copy is never replaced before the new one is
     * recorded. Never throws.
     */
    function saveShare(target: RequestHistoryShareTarget, chunks: Iterable<string>, time?: number): SaveReportResult {
        try {
            const key = shareKey(target);
            if (key === null || !folderReady(sharedDir, true)) {
                return { ok: false };
            }
            let at = typeof time === "number" && Number.isSafeInteger(time) && time >= 0 ? time : now();
            for (let attempt = 0; attempt < 3; attempt++, at++) {
                const name = `${new Date(at).toISOString().replace(/[-:.]/g, "")}-${key}.json`;
                const file = path.join(sharedDir, name);
                try {
                    lstatSync(file);
                    continue;
                } catch (error) {
                    if (!isMissing(error)) {
                        fail(error);
                        return { ok: false };
                    }
                }
                const parsed = parseShareFile(name);
                if (!parsed || !sameTarget(parsed.target, target)) {
                    return { ok: false };
                }
                const landed = writeAtomic(sharedDir, file, chunks, `share-${key}`);
                recountShares();
                void writeState();
                return landed ? { ok: true, name } : { ok: false };
            }
            fail(Object.assign(new Error("Every name drawn was taken"), { code: "EEXIST" }));
            return { ok: false };
        } catch (error) {
            fail(error);
            return { ok: false };
        }
    }

    /** Runs a removal and writes `state.json` after it. Never throws. */
    function removal(work: () => boolean): boolean {
        let ok = false;
        try {
            ok = work();
        } catch (error) {
            fail(error);
        }
        void writeState();
        return ok;
    }

    function listShares(): RequestHistoryShareEntry[] | null {
        try {
            const listing = shareEntries();
            if (!listing) {
                return null;
            }
            const newest = new Map<string, RequestHistoryShareEntry>();
            for (const file of listing.files) {
                const key = shareKey(file.target)!;
                const known = newest.get(key);
                if (!known || known.sharedAt < file.at) {
                    newest.set(key, { ...file.target, sharedAt: file.at });
                }
            }
            return [...newest.values()].sort((a, b) => b.sharedAt - a.sharedAt);
        } catch (error) {
            fail(error);
            return null;
        }
    }

    /**
     * The lines of one day file, in order, through `onLine`. Whether it was read whole: a refused
     * entry (not a regular file), a failed read, a line over `MAX_EVENT_LINE` (skipped), or an
     * unterminated tail is not.
     */
    function readDayFile(name: string, onLine: (line: string) => void): boolean {
        const file = path.join(eventsDir, name);
        let fd = -1;
        try {
            if (!lstatSync(file).isFile()) {
                return false;
            }
            fd = openSync(file, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
            if (!fstatSync(fd).isFile()) {
                return false;
            }
            let whole = true;
            let pending: Buffer[] = [];
            let pendingBytes = 0;
            let skipping = false;
            const chunk = Buffer.alloc(READ_CHUNK);
            for (;;) {
                const read = readSync(fd, chunk, 0, chunk.length, null);
                if (read <= 0) {
                    break;
                }
                let start = 0;
                for (let i = 0; i < read; i++) {
                    if (chunk[i] !== 0x0a) {
                        continue;
                    }
                    if (!skipping) {
                        if (pendingBytes + i - start > MAX_EVENT_LINE) {
                            whole = false;
                        } else {
                            pending.push(Buffer.from(chunk.subarray(start, i)));
                            onLine(Buffer.concat(pending).toString("utf8"));
                        }
                    }
                    pending = [];
                    pendingBytes = 0;
                    skipping = false;
                    start = i + 1;
                }
                if (start < read && !skipping) {
                    pendingBytes += read - start;
                    if (pendingBytes > MAX_EVENT_LINE) {
                        skipping = true;
                        whole = false;
                        pending = [];
                    } else {
                        pending.push(Buffer.from(chunk.subarray(start, read)));
                    }
                }
            }
            // A tail without its newline is an append cut short (or one in progress): not an event yet.
            return whole && pendingBytes === 0 && !skipping;
        } catch (error) {
            if (!isMissing(error)) {
                fail(error);
                return false;
            }
            return true;
        } finally {
            if (fd >= 0) {
                closeFd(fd);
            }
        }
    }

    function eventsFor(match: (event: DiagnosticEvent) => boolean, fromMs: number) {
        const found: { event: DiagnosticEvent; text: string }[] = [];
        let partial = false;
        try {
            const first = `${new Date(Math.max(0, fromMs - 60 * 60_000)).toISOString().slice(0, 10)}.jsonl`;
            const ready = (() => {
                try {
                    const stat = lstatSync(eventsDir);
                    return !stat.isSymbolicLink() && stat.isDirectory();
                } catch (error) {
                    // No `events/` yet: nothing was written to disk, the ring holds what there is.
                    return isMissing(error) ? null : false;
                }
            })();
            if (ready === false) {
                partial = true;
            } else if (ready) {
                const names = readdirSync(eventsDir, { withFileTypes: true })
                    .filter((entry) => DAY_FILE.test(entry.name) && entry.name >= first)
                    .map((entry) => entry.name)
                    .sort();
                for (const name of names) {
                    const whole = readDayFile(name, (line) => {
                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(line);
                        } catch {
                            partial = true;
                            return;
                        }
                        const event = projectServerEvent(parsed);
                        if (event && match(event)) {
                            found.push({ event, text: JSON.stringify(event) });
                        }
                    });
                    if (!whole) {
                        partial = true;
                    }
                }
            }
        } catch (error) {
            fail(error);
            partial = true;
        }
        // The ring's events the files hold are not added again: one ring copy per disk copy is passed over.
        const onDisk = new Map<string, number>();
        for (const { text } of found) {
            onDisk.set(text, (onDisk.get(text) ?? 0) + 1);
        }
        for (const event of ring) {
            if (event.at < fromMs - 60 * 60_000 || !match(event)) {
                continue;
            }
            const copied = copy(event);
            const text = JSON.stringify(copied);
            const left = onDisk.get(text) ?? 0;
            if (left > 0) {
                onDisk.set(text, left - 1);
            } else {
                found.push({ event: copied, text });
            }
        }
        if (lastDropAt !== null && lastDropAt >= fromMs - 60 * 60_000) {
            partial = true;
        }
        // Stable: equal times keep the file order, then the ring's.
        const events = found.map((entry) => entry.event).sort((a, b) => a.at - b.at);
        return { events, partial };
    }

    function state(): DiagnosticsState {
        const version = section(sources.appVersion);
        const build = section(sources.appBuild);
        const settings = section(sources.settings);
        const history = section(sources.history);
        const workers = section(sources.workers);
        const liveJobs = section(sources.liveJobs);
        return {
            version: 1,
            writtenAt: new Date(now()).toISOString(),
            app: {
                version: typeof version === "string" && APP_VERSION.test(version) ? version : null,
                build: typeof build === "string" && BUILD_ID_PATTERN.test(build) ? build : null,
            },
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
            startedAt: new Date(processStartedAt).toISOString(),
            uptimeSec: Math.round(process.uptime()),
            settings: settings && {
                requestHistoryContent:
                    typeof settings.requestHistoryContent === "boolean" ? settings.requestHistoryContent : null,
                requestHistoryLimit: countOrNull(settings.requestHistoryLimit),
            },
            history: history && { rows: countOrNull(history.rows), bytes: countOrNull(history.bytes) },
            journal: { eventBytes, writeFailures, dropped },
            shared: { files: sharedFiles },
            workers: workers && {
                workers: countOrNull(workers.workers),
                busy: countOrNull(workers.busy),
                queued: countOrNull(workers.queued),
                spawned: countOrNull(workers.spawned),
                terminated: countOrNull(workers.terminated),
            },
            jobs: liveJobs === null ? null : { live: countOrNull(liveJobs) },
            recentJobFailures: jobFailures.map(copy),
        };
    }

    const stateText = () => `${JSON.stringify(state(), null, 2)}\n`;

    function clearStateTimer() {
        if (stateTimer) {
            clearTimeout(stateTimer);
            stateTimer = null;
        }
    }

    /** Publishes `state.json` before it returns (temp file, then rename). Never throws: a failure is counted. */
    function writeStateSync() {
        clearStateTimer();
        try {
            writeAtomic(dir, path.join(dir, STATE_FILE), stateText(), "state");
        } catch (error) {
            fail(error);
        }
    }

    /**
     * One queued publication: `writeAtomic` over `fs`, with its state built here, so the latest wins,
     * and its rename on the JS thread behind the fence, so nothing lands after the final state. Past the
     * fence it does nothing, and one in flight attempts to remove its temp file; a cleanup failure
     * is counted and may leave it behind. The staged state is flushed before rename, as reports and
     * shares are by `writeAtomic`; the folder is synced afterwards.
     * A folder-sync failure propagated by `server/src/data/durableWrite.ts` is counted while the
     * renamed file remains landed. Never throws: a failure is counted.
     */
    async function publishState() {
        nextPublication = null;
        if (terminal) {
            return;
        }
        let temp: string | null = null;
        let handle: JournalFileHandle | null = null;
        try {
            const bytes = Buffer.from(stateText(), "utf8");
            const name = tempPath(dir, "state");
            handle = await fs.open(name, TEMP_FLAGS, FILE_MODE);
            temp = name;
            await handle.chmod(FILE_MODE);
            await writeAllQueued(handle, bytes);
            await handle.sync();
            const opened = handle;
            handle = null;
            await opened.close();
            if (terminal) {
                return;
            }
            renameSync(temp, path.join(dir, STATE_FILE));
            temp = null;
            try {
                await syncDir(dir, fs);
            } catch (error) {
                fail(error);
            }
        } catch (error) {
            fail(error);
        } finally {
            if (handle) {
                await closeQueued(handle);
            }
            if (temp !== null) {
                removeTemp(temp);
            }
        }
    }

    /** The marker clears when the publication starts, so a call during its I/O queues a successor. */
    function writeState(): Promise<void> {
        clearStateTimer();
        if (terminal) {
            writeStateSync();
            return Promise.resolve();
        }
        nextPublication ??= writer.run(STATE_KEY, publishState).catch(fail);
        return nextPublication;
    }

    /** Queues a publication at most `stateDelayMs` after the first error event since the last write. */
    function scheduleState() {
        if (stateTimer || closed) {
            return;
        }
        stateTimer = setTimeout(() => {
            stateTimer = null;
            void writeState();
        }, options.stateDelayMs ?? STATE_DELAY_MS);
        stateTimer.unref?.();
    }

    function close() {
        closed = true;
        clearStateTimer();
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
    }

    /** Keeps an accepted event in the ring and the job failures; null when the projection refuses it. */
    function remember(input: DiagnosticEventInput): DiagnosticEvent | null {
        const event = projectDiagnosticEvent({ ...input, at: now() });
        if (!event) {
            return null;
        }
        ring.push(event);
        if (ring.length > RING_SIZE) {
            ring.shift();
        }
        if (isJobFailureEvent(event)) {
            jobFailures.push(event);
            if (jobFailures.length > RECENT_JOB_FAILURES) {
                jobFailures.shift();
            }
        }
        return event;
    }

    const dayFileOf = (event: DiagnosticEvent) => `${new Date(event.at).toISOString().slice(0, 10)}.jsonl`;

    /** Waits for what the two keys hold, at most `drainDeadlineMs` (a stalled disk must not hold a shutdown). */
    async function drained() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, options.drainDeadlineMs ?? DRAIN_DEADLINE_MS);
        });
        await Promise.race([Promise.all([writer.settled(EVENTS_KEY), writer.settled(STATE_KEY)]), deadline]);
        clearTimeout(timer);
    }

    scan();

    return {
        record(input) {
            try {
                const event = remember(input);
                if (!event) {
                    return;
                }
                const line = `${JSON.stringify(event)}\n`;
                if (terminal) {
                    appendSync(dayFileOf(event), line);
                } else {
                    queueLine(dayFileOf(event), line, event.at);
                }
                if (isDiagnosticErrorEvent(event)) {
                    scheduleState();
                }
            } catch (error) {
                fail(error);
            }
        },
        recordFatal(input) {
            takeOver();
            try {
                const event = remember(input);
                if (event) {
                    appendSync(dayFileOf(event), `${JSON.stringify(event)}\n`);
                }
            } catch (error) {
                fail(error);
            }
            writeStateSync();
        },
        settled: () => (terminal ? Promise.resolve() : writer.settled(EVENTS_KEY)),
        recent: () => ring.map(copy),
        state,
        writeState,
        writeStateSync,
        start() {
            if (interval || closed) {
                return;
            }
            interval = setInterval(() => void writeState(), options.stateIntervalMs ?? STATE_INTERVAL_MS);
            interval.unref?.();
        },
        close,
        finish() {
            finishing ??= (async () => {
                close();
                if (!terminal) {
                    await drained();
                }
                takeOver();
                writeStateSync();
            })();
            return finishing;
        },
        stats: () => ({ eventBytes, writeFailures, dropped }),
        saveReport,
        eventsFor,
        saveShare,
        commitShare(target, keep) {
            return removal(() =>
                removeShareEntries(
                    (file) => file.name !== keep && sameTarget(file.target, target),
                    false,
                    (temp) => sameTarget(temp, target),
                ),
            );
        },
        discardShare(name) {
            return removal(() => {
                const ok = parseShareFile(name) !== null && unlinkShare(name);
                recountShares();
                return ok;
            });
        },
        removeShares(target) {
            return removal(
                () =>
                    shareKey(target) !== null &&
                    removeShareEntries(
                        (file) => sameTarget(file.target, target),
                        false,
                        (temp) => sameTarget(temp, target),
                    ),
            );
        },
        removeAllShares() {
            return removal(() => removeShareEntries(() => true, true));
        },
        listShares,
    };
}

function copy(event: DiagnosticEvent): DiagnosticEvent {
    const out: DiagnosticEvent = { ...event };
    for (const [key, value] of Object.entries(out)) {
        if (Array.isArray(value)) {
            out[key] = [...value];
        }
    }
    return out;
}
