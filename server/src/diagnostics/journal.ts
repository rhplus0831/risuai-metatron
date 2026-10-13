import { randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
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
import path from "node:path";
import {
    type DiagnosticEvent,
    type DiagnosticEventInput,
    type DiagnosticsState,
    isDiagnosticErrorEvent,
    isJobFailureEvent,
    projectDiagnosticEvent,
} from "../../../shared/diagnostics.ts";
import { MAX_DIAGNOSTIC_REPORT_BYTES, REPORT_FILE_PATTERN } from "../../../shared/diagnosticsReport.ts";
import type { DiagnosticsRecorder } from "./log.ts";

/** `RISU_DIAGNOSTICS_MAX_BYTES`' default: the cap of `events/`. */
export const DIAGNOSTICS_MAX_BYTES = 64 * 1024 * 1024;

const RING_SIZE = 300;
const RECENT_JOB_FAILURES = 20;
const STATE_INTERVAL_MS = 10 * 60_000;
const STATE_DELAY_MS = 5_000;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const STATE_FILE = "state.json";
const REPORTS_KEPT = 50;
const DIR_MODE = 0o750;
const FILE_MODE = 0o640;
/** Not defined on Windows: there the open does not protect the final component (the `lstat` before it remains). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/** What `state.json` reports besides the journal's own fields; each source is read on its own. */
export type DiagnosticsStateSources = {
    appVersion?: () => unknown;
    settings?: () => { requestHistoryContent: unknown; requestHistoryLimit: unknown };
    history?: () => { rows: unknown; bytes: unknown };
    workers?: () => Record<string, unknown>;
    liveJobs?: () => unknown;
};

export type DiagnosticsJournal = DiagnosticsRecorder & {
    /** The ring (the last 300 events), oldest first, as copies. */
    recent(): DiagnosticEvent[];
    /** The state `state.json` would hold now. */
    state(): DiagnosticsState;
    /** Writes `state.json` now (temp file, then rename). */
    writeState(): void;
    /** Starts the 10-minute `state.json` timer. Idempotent. */
    start(): void;
    /** Stops the timers and the state writes they would make; `record` and `writeState` still work. Idempotent. */
    close(): void;
    stats(): { eventBytes: number; writeFailures: number };
    /** Saves a checked report to `reports/` (newest 50 kept). Never throws: a failure is counted. */
    saveReport(text: string): SaveReportResult;
};

export type SaveReportResult = { ok: true; name: string } | { ok: false };

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
 * The server's diagnostics folder (`docs/plan/request-history-diagnostics.md` "Diagnostics folder",
 * slices 7 and 9): `events/YYYY-MM-DD.jsonl` (one projected event per line, the UTC day of its time),
 * `state.json`, and `reports/`. Content-free: every event goes through `projectDiagnosticEvent`, and the state is
 * built from explicit, checked fields.
 *
 * - `events/` is capped at `maxBytes`: past it, the oldest day file is deleted, the current one too
 *   when it alone passes the cap (the next event starts it again). Only `YYYY-MM-DD.jsonl` regular
 *   files are counted and deleted; anything else in the folder is left alone. The cap is enforced at
 *   creation and after every append.
 * - `state.json` is written at creation of the server context (the caller's `writeState`), every 10
 *   minutes (`start`), at most 5 s after an error event (`isDiagnosticErrorEvent`; a pending write is
 *   not postponed by later ones), and when the caller asks (a fatal fault, the final state at dispose).
 * - The writes are synchronous (an accepted trade-off): every job transition, request end, and
 *   HTTP answer of 400 or more blocks the event loop for one small append, and a fatal fault's event
 *   and state land before the process exits.
 * - Trust: the folder is the server's own; a group may read it (directories 0750, files 0640, set on
 *   what the journal creates; existing entries keep their modes). Inside it nothing is followed: a
 *   symlinked or non-directory `events/` stops every operation below it, a day file that is not a
 *   regular file is refused (`lstat`, then `O_NOFOLLOW | O_NONBLOCK` and `fstat`), and a symlink at
 *   `state.json` is replaced by the rename, not followed. The folder itself may be a symlink (a
 *   mount). This guards against a stray entry, not against a writer racing the server in its own folder.
 * - `reports/` holds the reports the Diagnostics panel saves (`saveReport`, slice 9): each written
 *   whole (temp file, then rename), the newest 50 kept (after a save, and at creation). The same
 *   refusals apply: a symlinked or non-directory `reports/` is not used, and only report-named
 *   regular files are counted and deleted.
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
}): DiagnosticsJournal {
    const dir = options.dir;
    const eventsDir = path.join(dir, "events");
    const reportsDir = path.join(dir, "reports");
    const maxBytes = options.maxBytes ?? DIAGNOSTICS_MAX_BYTES;
    const now = options.now ?? Date.now;
    const sources = options.sources ?? {};
    const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
    const ring: DiagnosticEvent[] = [];
    const jobFailures: DiagnosticEvent[] = [];
    /** Day file name → its bytes. */
    const files = new Map<string, number>();
    let eventBytes = 0;
    let writeFailures = 0;
    let warned = false;
    let closed = false;
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

    /** Writes all of `bytes` to `fd`; a write that makes no progress is a failure. */
    function writeAll(fd: number, bytes: Buffer) {
        let offset = 0;
        while (offset < bytes.length) {
            const written = writeSync(fd, bytes, offset, bytes.length - offset);
            if (written <= 0) {
                throw Object.assign(new Error("No progress"), { code: "EIO" });
            }
            offset += written;
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
     * is truncated back where it can be; the count follows the file.
     */
    function append(name: string, line: string) {
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
            fd = openSync(
                file,
                constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | NOFOLLOW | NONBLOCK,
                FILE_MODE,
            );
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
     * Deletes the oldest day files while `events/` passes the cap; stops at a deletion that fails
     * (a file already gone counts as deleted). Nothing is deleted through a refused `events/`.
     */
    function prune() {
        if (eventBytes <= maxBytes || !eventsReady(false)) {
            return;
        }
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

    /**
     * Writes `text` to `target` in `folder`: a temp file there (`O_EXCL | O_NOFOLLOW`, 0640), then a
     * rename. Whether it landed; a failure is counted, and the temp file removed when this call made it.
     */
    function writeAtomic(folder: string, target: string, text: string, tempPrefix: string): boolean {
        let temp: string | null = null;
        let fd = -1;
        try {
            const name = path.join(folder, `.${tempPrefix}-${randomBytes(4).toString("hex")}.tmp`);
            fd = openSync(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, FILE_MODE);
            temp = name;
            fchmodSync(fd, FILE_MODE);
            writeAll(fd, Buffer.from(text, "utf8"));
            const opened = fd;
            fd = -1;
            closeSync(opened);
            renameSync(temp, target);
            temp = null;
            return true;
        } catch (error) {
            fail(error);
            return false;
        } finally {
            if (fd >= 0) {
                closeFd(fd);
            }
            if (temp !== null) {
                try {
                    unlinkSync(temp);
                } catch (error) {
                    if (!isMissing(error)) {
                        fail(error);
                    }
                }
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

    function state(): DiagnosticsState {
        const version = section(sources.appVersion);
        const settings = section(sources.settings);
        const history = section(sources.history);
        const workers = section(sources.workers);
        const liveJobs = section(sources.liveJobs);
        return {
            version: 1,
            writtenAt: new Date(now()).toISOString(),
            app: { version: typeof version === "string" && APP_VERSION.test(version) ? version : null },
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
            journal: { eventBytes, writeFailures },
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

    /** Writes `state.json` (temp file, then rename). Never throws: a failure is counted. */
    function writeState() {
        if (stateTimer) {
            clearTimeout(stateTimer);
            stateTimer = null;
        }
        try {
            writeAtomic(dir, path.join(dir, STATE_FILE), `${JSON.stringify(state(), null, 2)}\n`, "state");
        } catch (error) {
            fail(error);
        }
    }

    /** At most `stateDelayMs` after the first error event since the last write. */
    function scheduleState() {
        if (stateTimer || closed) {
            return;
        }
        stateTimer = setTimeout(() => {
            stateTimer = null;
            writeState();
        }, options.stateDelayMs ?? STATE_DELAY_MS);
        stateTimer.unref?.();
    }

    scan();

    return {
        record(input) {
            try {
                const event = projectDiagnosticEvent({ ...input, at: now() });
                if (!event) {
                    return;
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
                append(`${new Date(event.at).toISOString().slice(0, 10)}.jsonl`, `${JSON.stringify(event)}\n`);
                prune();
                if (isDiagnosticErrorEvent(event)) {
                    scheduleState();
                }
            } catch (error) {
                fail(error);
            }
        },
        recent: () => ring.map(copy),
        state,
        writeState,
        start() {
            if (interval || closed) {
                return;
            }
            interval = setInterval(() => writeState(), options.stateIntervalMs ?? STATE_INTERVAL_MS);
            interval.unref?.();
        },
        close() {
            closed = true;
            if (stateTimer) {
                clearTimeout(stateTimer);
                stateTimer = null;
            }
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        },
        stats: () => ({ eventBytes, writeFailures }),
        saveReport,
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
