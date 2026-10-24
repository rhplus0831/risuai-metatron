// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DiagnosticEvent, type DiagnosticEventInput, ROUTE_TEMPLATES } from "../../../shared/diagnostics.ts";
import { BASE_LLM_MODELS } from "../../../shared/llm/models.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createRequestHistory } from "../data/requestHistory.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager } from "../data/snapshots.ts";
import {
    buildDiagnosticReport,
    canonicalDiagnosticReport,
    MAX_DIAGNOSTIC_REPORT_BYTES,
    REPORT_FILE_PATTERN,
} from "../../../shared/diagnosticsReport.ts";
import { createDiagnosticsJournal, DIAGNOSTICS_MAX_BYTES } from "../diagnostics/journal.ts";
import { type DiagnosticsRecorder, errorFields, logEvent, recordSafely } from "../diagnostics/log.ts";
import { createGenerationJobs, GenerationRunnerError, markFailure, type RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { createHistoryObserver } from "../llm/historyObserver.ts";
import { createResourceTestClient, createTestServer, sleep, TEST_INDEX_HTML, waitFor } from "./testSupport.ts";

// The server's diagnostics journal (`server/src/diagnostics/journal.ts`) and its wiring. The journal:
// one projected event per line in `events/<UTC day>.jsonl`, the 300-event ring and the last 20 job
// failures, the byte cap (oldest day first, the current day when it alone passes, at creation too),
// `state.json` built from explicit checked sources and written atomically, the timers (5 s after an
// error event, every 10 minutes, stopped by `close`), and every filesystem failure contained: a
// symlinked `events/`, a symlink or a FIFO in place of a day file, an unwritable or missing folder, a
// short write truncated back, a partial tail from an earlier process, each counted and warned once
// with its code only, nothing thrown. The wiring: the context's own folder (two contexts never share
// one), the `http` events with registered templates only, the `job` events from the registry (a
// broken folder never fails a job), the `request` events from the history observer, the `runtime`
// events from `logEvent`, the lifecycle events (boot, shutdown, maintenance, restore), and the final
// state at dispose while the stores are open. The crash hooks of `main.ts` run in a fresh process in
// `diagnosticsCrash.test.ts`. The reports: `saveReport` and `reports/` (the name, the modes, the temp
// file and rename with a taken name drawn again and a temp name never created never cleaned up, the
// newest 50 kept by name with the one just saved always retained and other entries left alone, at
// creation too, a symlinked or non-directory `reports/` refused, a failed prune leaving the save in
// place), and `POST /api/diagnostics/report` (the canonical check before the write, the body limit by
// declared and by actual bytes, the shutdown recheck after the body read, a failed save, `no-store`
// on every answer, the text never logged).

const { fsOverrides, randomQueue } = vi.hoisted(() => ({
    fsOverrides: {
        writeSync: null as null | ((fd: number, buffer: Buffer, offset: number, length: number) => number),
        unlinkSync: null as null | ((file: string) => void),
    },
    /** Hex values `randomBytes` answers next (the temp and report names), then the real ones. */
    randomQueue: [] as string[],
}));
// `node:fs` as it is, except a `writeSync` or an `unlinkSync` a test may replace for one journal operation.
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        writeSync: (fd: number, buffer: Buffer, offset: number, length: number) =>
            fsOverrides.writeSync
                ? fsOverrides.writeSync(fd, buffer, offset, length)
                : actual.writeSync(fd, buffer, offset, length),
        unlinkSync: (file: string) => (fsOverrides.unlinkSync ? fsOverrides.unlinkSync(file) : actual.unlinkSync(file)),
    };
});
// `node:crypto` as it is, except `randomBytes` answering the queued values first (the journal's names).
vi.mock("node:crypto", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:crypto")>();
    return {
        ...actual,
        randomBytes: (size: number) => {
            const next = randomQueue.shift();
            return next === undefined ? actual.randomBytes(size) : Buffer.from(next, "hex");
        },
    };
});
/** The real `node:fs`, outside the mock. */
const realFs = process.getBuiltinModule("node:fs") as typeof import("node:fs");

const posix = process.platform !== "win32";
const notRoot = posix && process.getuid?.() !== 0;
const ID = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
const CATALOG_MODEL = BASE_LLM_MODELS[0].id;
/** 2026-01-15T12:00:00Z; the tests move it by whole days. */
const DAY_ONE = Date.UTC(2026, 0, 15, 12);
const DAY_MS = 24 * 60 * 60 * 1000;
let clock = DAY_ONE;
const dayFile = (at: number) => `${new Date(at).toISOString().slice(0, 10)}.jsonl`;
/** An `http` line is 91 bytes with the test clock; a `runtime` one with a job id and 8 frames 291. */
const HTTP_LINE: DiagnosticEventInput = { kind: "http", method: "GET", route: "/*", status: 404, durationMs: 1 };
const BIG_LINE: DiagnosticEventInput = {
    kind: "runtime",
    origin: "dispose",
    jobId: ID,
    stack: Array(8).fill("server/src/x.ts:1:1"),
};

const cleanups: (() => Promise<void> | void)[] = [];
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    clock = DAY_ONE;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
    fsOverrides.writeSync = null;
    fsOverrides.unlinkSync = null;
    randomQueue.length = 0;
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
    vi.restoreAllMocks();
});

function tempDir(prefix = "risu-diagnostics-") {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => {
        // A folder a test made unwritable is made writable again, so it can be removed.
        for (const entry of [dir, ...walk(dir)]) {
            try {
                chmodSync(entry, 0o700);
            } catch {}
        }
        rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}
function walk(dir: string): string[] {
    const out: string[] = [];
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                out.push(full, ...walk(full));
            }
        }
    } catch {}
    return out;
}
/** A server root with the client and a password, for `createTestServer({ rootDir })`. */
function makeRoot(): string {
    const root = tempDir("risu-diagnostics-root-");
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "index.html"), TEST_INDEX_HTML);
    mkdirSync(path.join(root, "save", "server"), { recursive: true });
    writeFileSync(path.join(root, "save", "server", "password"), "pw");
    return root;
}

/** A journal in `<temp>/diag` with the test clock; `sources` and the sizes as given. */
function openJournal(options: Partial<Parameters<typeof createDiagnosticsJournal>[0]> = {}) {
    const root = tempDir();
    const dir = options.dir ?? path.join(root, "diag");
    const journal = createDiagnosticsJournal({ now: () => clock, ...options, dir });
    cleanups.push(() => journal.close());
    return { root, dir, events: path.join(dir, "events"), journal };
}
const lines = (file: string): DiagnosticEvent[] =>
    readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as DiagnosticEvent);
const readState = (dir: string) =>
    JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as Record<string, unknown>;
const mode = (file: string) => statSync(file).mode & 0o777;
const sizes = (events: string) =>
    readdirSync(events)
        .sort()
        .map((name) => [name, statSync(path.join(events, name)).size] as const);
const totalSize = (events: string) => sizes(events).reduce((sum, [, size]) => sum + size, 0);
const boot: DiagnosticEventInput = { kind: "lifecycle", phase: "boot" };
const failure = (reason = "failed"): DiagnosticEventInput => ({ kind: "job", phase: "error", jobId: ID, reason });
/** The journal's warnings: `[Diagnostics] Could not write…` with the code only. */
const warnings = (): unknown[][] =>
    (warn.mock.calls as unknown[][]).filter((call) => String(call[0]).startsWith("[Diagnostics]"));
const warnedCodes = () => warnings().map((call) => call[1]);
const WARNING = "[Diagnostics] Could not write the diagnostics folder:";

describe("the journal's folder and events", () => {
    it("creates the folder and `events/` (0750), appends each projected event as one JSON line to the UTC day's file (0640), and counts the bytes", () => {
        const { dir, events, journal } = openJournal();
        expect(lstatSync(events).isDirectory()).toBe(true);
        expect(journal.stats()).toEqual({ eventBytes: 0, writeFailures: 0 });
        expect(readdirSync(events)).toEqual([]);

        journal.record(boot);
        journal.record({ ...HTTP_LINE, url: "/secret?x=1" });
        clock += DAY_MS;
        journal.record({ kind: "lifecycle", phase: "shutdown", message: "secret" });

        expect(readdirSync(events).sort()).toEqual([dayFile(DAY_ONE), dayFile(DAY_ONE + DAY_MS)]);
        expect(lines(path.join(events, dayFile(DAY_ONE)))).toEqual([
            { at: DAY_ONE, kind: "lifecycle", phase: "boot" },
            { at: DAY_ONE, ...HTTP_LINE },
        ]);
        expect(lines(path.join(events, dayFile(DAY_ONE + DAY_MS)))).toEqual([
            { at: DAY_ONE + DAY_MS, kind: "lifecycle", phase: "shutdown" },
        ]);
        const text = readFileSync(path.join(events, dayFile(DAY_ONE)), "utf8");
        expect(text.endsWith("\n")).toBe(true);
        expect(text).not.toContain("secret");
        expect(statSync(path.join(events, dayFile(DAY_ONE))).size).toBe(Buffer.byteLength(text));
        expect(journal.stats().eventBytes).toBe(totalSize(events));
        if (posix) {
            expect(mode(dir)).toBe(0o750);
            expect(mode(events)).toBe(0o750);
            expect(mode(path.join(events, dayFile(DAY_ONE)))).toBe(0o640);
        }
        expect(warnings()).toEqual([]);
    });

    it("drops an event the projection refuses, with nothing written", () => {
        const { events, journal } = openJournal();
        journal.record({ kind: "script", name: "Error" } as never);
        journal.record({ kind: "Private" } as never);
        expect(readdirSync(events)).toEqual([]);
        expect(journal.recent()).toEqual([]);
        expect(journal.stats()).toEqual({ eventBytes: 0, writeFailures: 0 });
    });

    it("keeps the last 300 events in the ring and the last 20 job failures (an owner's abort is not one), as copies", () => {
        const { journal } = openJournal();
        for (let i = 0; i < 310; i++) {
            journal.record({ ...HTTP_LINE, durationMs: i });
        }
        const recent = journal.recent();
        expect(recent).toHaveLength(300);
        expect(recent[0]).toMatchObject({ durationMs: 10 });
        expect(recent[299]).toMatchObject({ durationMs: 309 });
        recent[0].durationMs = 999;
        expect(journal.recent()[0]).toMatchObject({ durationMs: 10 });

        for (let i = 0; i < 25; i++) {
            journal.record({ ...failure(), durationMs: i });
        }
        journal.record(failure("aborted"));
        journal.record({ kind: "job", phase: "done", jobId: ID });
        const failures = journal.state().recentJobFailures;
        expect(failures).toHaveLength(20);
        expect(failures.map((event) => event.durationMs)).toEqual(Array.from({ length: 20 }, (_, i) => i + 5));
        expect(failures.every((event) => event.reason === "failed")).toBe(true);
        failures[0].reason = "changed";
        expect(journal.state().recentJobFailures[0].reason).toBe("failed");
        // A runtime event's frames are copied too.
        journal.record({ kind: "runtime", origin: "dispose", stack: ["server/src/app.ts:1:1"] });
        const last = journal.recent().at(-1)!;
        (last.stack as string[]).push("server/src/evil.ts:1:1");
        expect(journal.recent().at(-1)!.stack).toEqual(["server/src/app.ts:1:1"]);
    });

    it("prunes past the cap: the oldest day file first, the current day too when it alone passes, and the next event starts it again", () => {
        const { events, journal } = openJournal({ maxBytes: 400 });
        // Two days of two lines (91 bytes each) fit under 400; a third day's first line does not.
        const LINE = Buffer.byteLength(JSON.stringify({ at: DAY_ONE, ...HTTP_LINE })) + 1;
        expect(4 * LINE).toBeLessThanOrEqual(400);
        expect(5 * LINE).toBeGreaterThan(400);
        journal.record(HTTP_LINE);
        journal.record(HTTP_LINE);
        clock += DAY_MS;
        journal.record(HTTP_LINE);
        journal.record(HTTP_LINE);
        expect(totalSize(events)).toBe(4 * LINE);
        clock += DAY_MS;
        journal.record(HTTP_LINE);
        expect(readdirSync(events).sort()).toEqual([dayFile(DAY_ONE + DAY_MS), dayFile(DAY_ONE + 2 * DAY_MS)]);
        expect(journal.stats().eventBytes).toBe(totalSize(events));
        expect(totalSize(events)).toBe(3 * LINE);

        // The current day grows past the cap: the older day goes first.
        journal.record(HTTP_LINE);
        journal.record(HTTP_LINE);
        expect(readdirSync(events)).toEqual([dayFile(DAY_ONE + 2 * DAY_MS)]);
        expect(lines(path.join(events, dayFile(DAY_ONE + 2 * DAY_MS)))).toHaveLength(3);
        // A day that alone passes the cap is deleted; the next event starts it again.
        journal.record(BIG_LINE);
        expect(readdirSync(events)).toEqual([]);
        expect(journal.stats().eventBytes).toBe(0);
        journal.record(HTTP_LINE);
        expect(lines(path.join(events, dayFile(DAY_ONE + 2 * DAY_MS)))).toEqual([{ at: clock, ...HTTP_LINE }]);
        expect(journal.stats()).toEqual({ eventBytes: LINE, writeFailures: 0 });
        // The ring keeps what the files lost.
        expect(journal.recent().length).toBe(9);
        expect(warnings()).toEqual([]);
    });

    it("prunes an oversized folder at creation, counting only day files and leaving every other entry alone", () => {
        const root = tempDir();
        const dir = path.join(root, "diag");
        const events = path.join(dir, "events");
        mkdirSync(events, { recursive: true });
        writeFileSync(path.join(events, "2026-01-01.jsonl"), "x".repeat(100));
        writeFileSync(path.join(events, "2026-01-02.jsonl"), "x".repeat(100));
        writeFileSync(path.join(events, "2026-01-03.jsonl"), "x".repeat(100));
        writeFileSync(path.join(events, "notes.txt"), "x".repeat(1000));
        writeFileSync(path.join(events, "2026-01-04.jsonl.bak"), "x".repeat(1000));
        mkdirSync(path.join(events, "2026-01-05.jsonl"));
        const journal = createDiagnosticsJournal({ dir, maxBytes: 250, now: () => clock });
        cleanups.push(() => journal.close());
        expect(readdirSync(events).sort()).toEqual([
            "2026-01-02.jsonl",
            "2026-01-03.jsonl",
            "2026-01-04.jsonl.bak",
            "2026-01-05.jsonl",
            "notes.txt",
        ]);
        expect(journal.stats()).toEqual({ eventBytes: 200, writeFailures: 0 });
        // A file that went away on its own is not a failure; a line over the cap on its own leaves no file.
        rmSync(path.join(events, "2026-01-02.jsonl"));
        journal.record(BIG_LINE);
        expect(journal.stats()).toEqual({ eventBytes: 0, writeFailures: 0 });
        expect(readdirSync(events).sort()).toEqual(["2026-01-04.jsonl.bak", "2026-01-05.jsonl", "notes.txt"]);
        expect(warnings()).toEqual([]);
    });

    it("starts the next line on a new line when the day file does not end in one (a partial tail from an earlier process)", () => {
        const root = tempDir();
        const dir = path.join(root, "diag");
        const events = path.join(dir, "events");
        mkdirSync(events, { recursive: true });
        const file = path.join(events, dayFile(DAY_ONE));
        writeFileSync(file, '{"at":1,"kind":"lifecycle","phase":"boot"}\n{"at":2,"ki');
        const journal = createDiagnosticsJournal({ dir, now: () => clock });
        cleanups.push(() => journal.close());
        journal.record(boot);
        const text = readFileSync(file, "utf8");
        expect(text).toBe(
            `{"at":1,"kind":"lifecycle","phase":"boot"}\n{"at":2,"ki\n{"at":${DAY_ONE},"kind":"lifecycle","phase":"boot"}\n`,
        );
        expect(journal.stats()).toEqual({ eventBytes: Buffer.byteLength(text), writeFailures: 0 });
        // Every complete line parses; only the cut one does not.
        const parsed = text.split("\n").filter(Boolean);
        expect(parsed).toHaveLength(3);
        expect(() => JSON.parse(parsed[0])).not.toThrow();
        expect(() => JSON.parse(parsed[2])).not.toThrow();
    });

    it("truncates a failed append back to the line before it, resyncs the count from the file, and appends cleanly next", () => {
        const { events, journal } = openJournal();
        journal.record(boot);
        const file = path.join(events, dayFile(DAY_ONE));
        const before = statSync(file).size;
        // A short write, then the disk is full.
        let calls = 0;
        fsOverrides.writeSync = (fd, buffer, offset) => {
            calls++;
            if (calls === 1) {
                return realFs.writeSync(fd, buffer, offset, 3);
            }
            throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
        };
        journal.record({ kind: "lifecycle", phase: "shutdown" });
        fsOverrides.writeSync = null;
        expect(calls).toBe(2);
        expect(statSync(file).size).toBe(before);
        expect(journal.stats()).toEqual({ eventBytes: before, writeFailures: 1 });
        expect(warnings()).toEqual([[WARNING, "ENOSPC"]]);
        journal.record({ kind: "lifecycle", phase: "shutdown" });
        expect(lines(file)).toEqual([
            { at: DAY_ONE, kind: "lifecycle", phase: "boot" },
            { at: DAY_ONE, kind: "lifecycle", phase: "shutdown" },
        ]);
        expect(journal.stats()).toEqual({ eventBytes: statSync(file).size, writeFailures: 1 });
        // The ring kept the event the file lost.
        expect(journal.recent().map((event) => event.phase)).toEqual(["boot", "shutdown", "shutdown"]);
        // A write that makes no progress is a failure, not a loop.
        fsOverrides.writeSync = () => 0;
        journal.record(boot);
        fsOverrides.writeSync = null;
        expect(journal.stats()).toEqual({ eventBytes: statSync(file).size, writeFailures: 2 });
        expect(lines(file)).toHaveLength(2);
        expect(warnings()).toHaveLength(1);
    });
});

describe("the journal's refusals and failures", () => {
    it("refuses a symlinked `events/`: nothing is written or pruned through it, the failure is counted, warned once with its code", () => {
        const root = tempDir();
        const dir = path.join(root, "diag");
        const elsewhere = path.join(root, "elsewhere");
        mkdirSync(dir, { recursive: true });
        mkdirSync(elsewhere);
        writeFileSync(path.join(elsewhere, "2020-01-01.jsonl"), "x".repeat(1000));
        symlinkSync(elsewhere, path.join(dir, "events"), "dir");
        const journal = createDiagnosticsJournal({ dir, maxBytes: 10, now: () => clock });
        cleanups.push(() => journal.close());
        expect(journal.stats()).toEqual({ eventBytes: 0, writeFailures: 1 });
        journal.record(boot);
        journal.record(boot);
        expect(journal.stats()).toEqual({ eventBytes: 0, writeFailures: 3 });
        expect(readdirSync(elsewhere)).toEqual(["2020-01-01.jsonl"]);
        expect(statSync(path.join(elsewhere, "2020-01-01.jsonl")).size).toBe(1000);
        expect(lstatSync(path.join(dir, "events")).isSymbolicLink()).toBe(true);
        expect(journal.recent()).toHaveLength(2);
        expect(warnings()).toEqual([[WARNING, "ESYMLINK"]]);
        // `state.json` is still written beside it.
        journal.writeState();
        expect(readState(dir)).toMatchObject({ journal: { eventBytes: 0, writeFailures: 3 } });
    });

    it("refuses a regular file in place of `events/`, and a symlink or a FIFO in place of the day file, without following or blocking", () => {
        const asFile = openJournal({ dir: path.join(tempDir(), "f") });
        rmSync(asFile.events, { recursive: true });
        writeFileSync(asFile.events, "not a directory");
        asFile.journal.record(boot);
        expect(readFileSync(asFile.events, "utf8")).toBe("not a directory");
        expect(asFile.journal.stats().writeFailures).toBe(1);

        const { root, events, journal } = openJournal();
        const target = path.join(root, "target.jsonl");
        writeFileSync(target, "keep\n");
        symlinkSync(target, path.join(events, dayFile(DAY_ONE)));
        journal.record(boot);
        expect(readFileSync(target, "utf8")).toBe("keep\n");
        expect(lstatSync(path.join(events, dayFile(DAY_ONE))).isSymbolicLink()).toBe(true);
        expect(journal.stats().writeFailures).toBe(1);
        if (posix) {
            clock += DAY_MS;
            execFileSync("mkfifo", [path.join(events, dayFile(clock))]);
            journal.record(boot);
            expect(lstatSync(path.join(events, dayFile(clock))).isFIFO()).toBe(true);
            expect(journal.stats().writeFailures).toBe(2);
        }
        // Another day is unaffected.
        clock += DAY_MS;
        journal.record(boot);
        expect(lines(path.join(events, dayFile(clock)))).toEqual([{ at: clock, kind: "lifecycle", phase: "boot" }]);
        expect(journal.stats().eventBytes).toBe(statSync(path.join(events, dayFile(clock))).size);
        // One warning per journal.
        expect(warnedCodes()).toEqual(["ESYMLINK", "ESYMLINK"]);
    });

    it.runIf(notRoot)("counts and warns once when the folder is not writable, and nothing throws", () => {
        const { dir, events, journal } = openJournal();
        journal.record(boot);
        chmodSync(events, 0o500);
        chmodSync(dir, 0o500);
        clock += DAY_MS;
        expect(() => journal.record(boot)).not.toThrow();
        expect(() => journal.record(boot)).not.toThrow();
        expect(() => journal.writeState()).not.toThrow();
        expect(journal.stats().writeFailures).toBe(3);
        expect(warnings()).toEqual([[WARNING, "EACCES"]]);
        expect(readdirSync(dir).sort()).toEqual(["events"]);
        expect(readdirSync(events)).toEqual([dayFile(DAY_ONE)]);
        chmodSync(dir, 0o750);
        chmodSync(events, 0o750);
        journal.record(boot);
        journal.writeState();
        expect(readdirSync(events).sort()).toEqual([dayFile(DAY_ONE), dayFile(DAY_ONE + DAY_MS)]);
        expect(readState(dir)).toMatchObject({ journal: { writeFailures: 3 } });
    });

    it("works without its folder: a file in its place, or the folder removed later, fails every write quietly", () => {
        const root = tempDir();
        const asFile = path.join(root, "diag");
        writeFileSync(asFile, "a file");
        const journal = createDiagnosticsJournal({ dir: asFile, now: () => clock });
        cleanups.push(() => journal.close());
        expect(journal.stats().writeFailures).toBe(1);
        expect(() => journal.record(boot)).not.toThrow();
        expect(journal.stats().writeFailures).toBe(2);
        expect(() => journal.writeState()).not.toThrow();
        expect(journal.recent()).toHaveLength(1);
        // The state's open is one failure; a temp name the open never created is not cleaned up (not a second one).
        expect(journal.stats().writeFailures).toBe(3);
        expect(readFileSync(asFile, "utf8")).toBe("a file");
        expect(warnings()).toHaveLength(1);
        expect(["EEXIST", "ENOTDIR"]).toContain(warnedCodes()[0]);

        const gone = openJournal();
        gone.journal.record(boot);
        rmSync(gone.dir, { recursive: true });
        expect(() => gone.journal.writeState()).not.toThrow();
        expect(gone.journal.stats().writeFailures).toBe(1);
        expect(warnedCodes()[1]).toBe("ENOENT");
        // `events/` is created again on the next append (the folder came back), the count following the file.
        mkdirSync(gone.dir);
        gone.journal.record(boot);
        expect(lines(path.join(gone.events, dayFile(DAY_ONE)))).toHaveLength(1);
        expect(gone.journal.stats()).toEqual({
            eventBytes: statSync(path.join(gone.events, dayFile(DAY_ONE))).size,
            writeFailures: 1,
        });
    });
});

describe("state.json", () => {
    it("is built from explicit checked fields, each source on its own: a throwing source is null, a wrong value null, the version bounded", () => {
        const { dir, journal } = openJournal({
            sources: {
                appVersion: () => "2.0.1-beta+3",
                settings: () => ({ requestHistoryContent: false, requestHistoryLimit: 250 }),
                history: () => ({ rows: 3, bytes: 4096 }),
                workers: () => ({ workers: 2, busy: 1, queued: 0, spawned: 5, terminated: 3, secret: "x" }),
                liveJobs: () => 1,
            },
        });
        journal.record(failure());
        journal.record(failure("aborted"));
        journal.writeState();
        const state = readState(dir);
        expect(state).toEqual({
            version: 1,
            writtenAt: new Date(DAY_ONE).toISOString(),
            app: { version: "2.0.1-beta+3" },
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
            startedAt: state.startedAt,
            uptimeSec: state.uptimeSec,
            settings: { requestHistoryContent: false, requestHistoryLimit: 250 },
            history: { rows: 3, bytes: 4096 },
            journal: { eventBytes: journal.stats().eventBytes, writeFailures: 0 },
            // The copies in `shared/` (none yet; the folder is made by the first share).
            shared: { files: 0 },
            workers: { workers: 2, busy: 1, queued: 0, spawned: 5, terminated: 3 },
            jobs: { live: 1 },
            recentJobFailures: [{ at: DAY_ONE, kind: "job", phase: "error", jobId: ID, reason: "failed" }],
        });
        expect(typeof state.uptimeSec).toBe("number");
        expect(() => new Date(state.startedAt as string).toISOString()).not.toThrow();
        expect(JSON.stringify(state)).not.toContain("secret");
        expect(readdirSync(dir).sort()).toEqual(["events", "state.json"]);
        if (posix) {
            expect(mode(path.join(dir, "state.json"))).toBe(0o640);
        }

        const odd = openJournal({
            sources: {
                appVersion: () => "1.0 (Alice's build with a long free text in it)",
                settings: () => {
                    throw new Error("closed");
                },
                history: () => ({ rows: "3", bytes: -1 }),
                workers: () => ({ busy: 1.5 }),
                liveJobs: () => {
                    throw new Error("closed");
                },
            },
        });
        expect(odd.journal.state()).toMatchObject({
            app: { version: null },
            settings: null,
            history: { rows: null, bytes: null },
            workers: { workers: null, busy: null, queued: null, spawned: null, terminated: null },
            jobs: null,
        });
        const none = openJournal();
        expect(none.journal.state()).toMatchObject({
            app: { version: null },
            settings: null,
            history: null,
            workers: null,
            jobs: null,
            recentJobFailures: [],
        });
    });

    it("is replaced atomically: a temp file renamed over it, none left behind, a symlink at its path replaced and never followed, a directory there a counted failure", () => {
        const { root, dir, journal } = openJournal();
        journal.writeState();
        const first = readState(dir);
        clock += 1000;
        journal.writeState();
        expect(readState(dir).writtenAt).not.toBe(first.writtenAt);
        expect(readdirSync(dir).sort()).toEqual(["events", "state.json"]);

        const target = path.join(root, "target.json");
        writeFileSync(target, "keep");
        rmSync(path.join(dir, "state.json"));
        symlinkSync(target, path.join(dir, "state.json"));
        journal.writeState();
        expect(readFileSync(target, "utf8")).toBe("keep");
        expect(lstatSync(path.join(dir, "state.json")).isSymbolicLink()).toBe(false);
        expect(readState(dir)).toMatchObject({ version: 1 });
        expect(journal.stats().writeFailures).toBe(0);

        rmSync(path.join(dir, "state.json"));
        mkdirSync(path.join(dir, "state.json"));
        expect(() => journal.writeState()).not.toThrow();
        expect(journal.stats().writeFailures).toBe(1);
        expect(readdirSync(dir).sort()).toEqual(["events", "state.json"]);
        expect(readdirSync(path.join(dir, "state.json"))).toEqual([]);
        expect(warnings()).toHaveLength(1);
    });

    it("is written at most 5 s after the first error event (not postponed by later ones), every 10 minutes once started, and no more after close", () => {
        vi.useFakeTimers({ now: DAY_ONE });
        const { dir, journal } = openJournal();
        const written = () => (existsSync(path.join(dir, "state.json")) ? readState(dir).writtenAt : null);
        journal.record(HTTP_LINE);
        journal.record(failure("aborted"));
        vi.advanceTimersByTime(10_000);
        expect(written()).toBeNull();

        journal.record(failure());
        vi.advanceTimersByTime(4_000);
        expect(written()).toBeNull();
        journal.record(failure());
        journal.record({ ...HTTP_LINE, status: 500 });
        clock += 5_000;
        vi.advanceTimersByTime(1_000);
        expect(written()).toBe(new Date(DAY_ONE + 5_000).toISOString());
        // A write made by the caller clears a pending one.
        journal.record({ kind: "request", requestId: ID, status: "error" });
        clock += 1_000;
        journal.writeState();
        expect(written()).toBe(new Date(DAY_ONE + 6_000).toISOString());
        clock += 10_000;
        vi.advanceTimersByTime(10_000);
        expect(written()).toBe(new Date(DAY_ONE + 6_000).toISOString());

        journal.start();
        journal.start();
        clock += 10 * 60_000;
        vi.advanceTimersByTime(10 * 60_000);
        expect(written()).toBe(new Date(DAY_ONE + 16_000 + 10 * 60_000).toISOString());
        clock += 10 * 60_000;
        vi.advanceTimersByTime(10 * 60_000);
        expect(written()).toBe(new Date(DAY_ONE + 16_000 + 20 * 60_000).toISOString());

        journal.close();
        journal.close();
        journal.record({ kind: "runtime", origin: "dispose" });
        clock += 10 * 60_000;
        vi.advanceTimersByTime(20 * 60_000);
        expect(written()).toBe(new Date(DAY_ONE + 16_000 + 20 * 60_000).toISOString());
        journal.start();
        vi.advanceTimersByTime(20 * 60_000);
        expect(written()).toBe(new Date(DAY_ONE + 16_000 + 20 * 60_000).toISOString());
        // Closed, the journal still records and writes on demand (a fatal fault, the final state).
        expect(journal.recent().at(-1)).toMatchObject({ kind: "runtime", origin: "dispose" });
        journal.writeState();
        expect(written()).toBe(new Date(DAY_ONE + 16_000 + 30 * 60_000).toISOString());
        expect(journal.stats().writeFailures).toBe(0);
    });

    it("never throws from a timer when the write fails: the failure is counted", () => {
        vi.useFakeTimers({ now: DAY_ONE });
        const { dir, journal } = openJournal();
        journal.start();
        rmSync(dir, { recursive: true });
        journal.record(failure());
        expect(() => vi.advanceTimersByTime(10 * 60_000)).not.toThrow();
        // The append, the error event's write, and the interval's write all failed.
        expect(journal.stats().writeFailures).toBe(3);
        expect(warnings()).toHaveLength(1);
    });
});

describe("the recorder helpers", () => {
    it("`logEvent` records a caught fault as a `runtime` event with the origin, job, name, and frames, never `generation.failed`, and survives a throwing recorder", () => {
        const recorded: DiagnosticEventInput[] = [];
        const recorder: DiagnosticsRecorder = { record: (input) => void recorded.push(input) };
        const error = new TypeError("the secret message");
        error.stack = `TypeError: the secret message\n    at fn (${path.resolve("server/src/prompt/runner.ts")}:10:5)\n    at other (/x/node_modules/y.js:1:1)`;
        logEvent("generation.release", { job: ID }, error, recorder);
        logEvent("generation.failed", { job: ID, stage: "request" }, error, recorder);
        logEvent("generation.listener", { job: "Private Name" }, "not an error", recorder);
        expect(recorded).toEqual([
            {
                kind: "runtime",
                origin: "generation.release",
                jobId: ID,
                name: "TypeError",
                stack: ["server/src/prompt/runner.ts:10:5"],
            },
            { kind: "runtime", origin: "generation.listener", jobId: "Private Name", name: "?", stack: [] },
        ]);
        expect(JSON.stringify(recorded)).not.toContain("secret");
        const throwing: DiagnosticsRecorder = {
            record: () => {
                throw new Error("journal broke");
            },
        };
        expect(() => logEvent("generation.release", { job: ID }, error, throwing)).not.toThrow();
        expect(() => recordSafely(throwing, boot)).not.toThrow();
        expect(() => recordSafely(undefined, boot)).not.toThrow();
        recordSafely(recorder, boot);
        expect(recorded.at(-1)).toEqual(boot);
    });

    it("`errorFields` never throws: an error whose accessors throw is `?` with no frames", () => {
        const hostile = new Error("x");
        Object.defineProperty(hostile, "stack", {
            get() {
                throw new Error("no stack for you");
            },
        });
        expect(errorFields(hostile)).toEqual({ name: "?", stack: [] });
        const named = new Error("x");
        Object.defineProperty(named, "name", {
            get() {
                throw new Error("no name for you");
            },
        });
        expect(errorFields(named)).toEqual({ name: "?", stack: [] });
        expect(errorFields(undefined)).toEqual({ name: "?", stack: [] });
        expect(errorFields(new RangeError("y"))).toMatchObject({ name: "RangeError" });
    });

    it("the history observer records a `request` event at the end with the ids, source, outcome, provider name, catalog model or `custom`, last status, code, duration, and bytes", () => {
        const root = tempDir();
        const history = createRequestHistory({ file: path.join(root, "history.sqlite") });
        cleanups.push(() => history.close());
        const recorded: DiagnosticEventInput[] = [];
        const observer = createHistoryObserver(history, {
            content: () => true,
            diagnostics: { record: (input) => void recorded.push(input) },
        });
        const begin = (requestId: string) => ({
            requestId,
            jobId: ID,
            source: "send" as const,
            mode: "model" as const,
            chatRef: { chaId: "c", chatId: "k" },
            messageId: "m1",
            startedAt: 1_000,
        });
        const entry = (status: number | undefined) =>
            ({
                url: "https://provider.example/v1?key=secret",
                body: "the prompt",
                response: "the answer",
                success: true,
                status,
            }) as never;
        observer.begin(begin("r1"));
        observer.describe!("r1", {
            modelId: CATALOG_MODEL,
            profileId: "p",
            profileName: "Main",
            provider: "Anthropic",
        });
        observer.exchange!("r1", entry(200), { requestBytes: 10, responseBytes: 20 });
        observer.exchange!("r1", entry(529), { requestBytes: 5, responseBytes: 7 });
        observer.finish(
            "r1",
            { status: "error", completedAt: 3_500 },
            { error: "secret", providerCode: "overloaded_error" },
        );
        expect(recorded).toEqual([
            {
                kind: "request",
                requestId: "r1",
                jobId: ID,
                source: "send",
                status: "error",
                provider: "Anthropic",
                model: CATALOG_MODEL,
                httpStatus: 529,
                providerCode: "overloaded_error",
                durationMs: 2_500,
                requestBytes: 15,
                responseBytes: 27,
            },
        ]);
        expect(JSON.stringify(recorded)).not.toContain("secret");
        // A model outside the catalog is `custom`; without `describe` there is no model or provider.
        observer.begin(begin("r2"));
        observer.describe!("r2", {
            modelId: "alice/private",
            profileId: null,
            profileName: null,
            provider: "OpenAICompatible",
        });
        observer.finish("r2", { status: "success", completedAt: 1_000 });
        observer.begin(begin("r3"));
        observer.finish("r3", { status: "aborted", completedAt: 900 });
        expect(recorded.slice(1)).toEqual([
            expect.objectContaining({ requestId: "r2", model: "custom", provider: "OpenAICompatible", durationMs: 0 }),
            expect.objectContaining({ requestId: "r3", status: "aborted", model: null, provider: null, durationMs: 0 }),
        ]);
        // A throwing recorder never reaches the request: the row still ends.
        const broken = createHistoryObserver(history, {
            content: () => true,
            diagnostics: {
                record: () => {
                    throw new Error("journal broke");
                },
            },
        });
        broken.begin(begin("r4"));
        expect(() => broken.finish("r4", { status: "success", completedAt: 2_000 })).not.toThrow();
        expect(history.get("r4")).toMatchObject({ status: "success", completedAt: 2_000 });
    });
});

describe("the job registry", () => {
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    /** A store with one bound chat and a registry recording to `diagnostics`; the runner is set per job. */
    function setup(diagnostics: DiagnosticsRecorder) {
        const dir = tempDir("risu-diagnostics-jobs-");
        const lock = createGenerationLock();
        const store = createResourceStore({ file: path.join(dir, "data", "resources.sqlite"), kinds, guard: lock });
        const snapshots = createSnapshotManager({ store, dir: path.join(dir, "backups") });
        let runner: (job: RunningJob) => Promise<void> = async () => {};
        const jobs = createGenerationJobs({
            store,
            kinds,
            gate: snapshots.gate,
            snapshots,
            lock,
            authorize: async () => true,
            runner: (job) => runner(job),
            diagnostics,
        });
        cleanups.push(async () => {
            jobs.beginShutdown();
            await jobs.drain();
            jobs.dispose();
            await snapshots.stop();
            store.close();
        });
        const firstId = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
        const bound = {
            presetId: firstId("presets"),
            modelPresetId: firstId("modelPresets"),
            personaId: firstId("personas"),
        };
        store.applyChanges({
            ops: [{ kind: kinds.get("characters")!, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                name: "K",
                                modelPresetId: bound.modelPresetId,
                                promptPresetId: bound.presetId,
                                bindedPersona: bound.personaId,
                                message: [{ role: "user", data: "hi", chatId: "u" }],
                            } as never,
                        },
                    ],
                },
            ],
        });
        const create = (run: (job: RunningJob) => Promise<void>) => {
            runner = run;
            const result = jobs.create(
                {
                    kind: "command",
                    context: {
                        characterId: "c",
                        chatId: "k",
                        ...bound,
                        mode: "normal",
                        input: "",
                        chatRevision: store.chatRevision("c", "k")!,
                    },
                    clientId: "tab",
                    command: { type: "button", data: "" },
                },
                store.epoch(),
            );
            if (!result.ok) {
                throw new Error(`create: ${result.status} ${JSON.stringify(result.body)}`);
            }
            return result.jobId;
        };
        const ended = (jobId: string) => waitFor(() => jobs.status(jobId, "tab")?.state === "ended");
        return { jobs, create, ended };
    }

    it("records `accepted` at admission and `done` or `error` (with the failure fields and the duration) at the end, and counts the live jobs", async () => {
        const { events, journal } = openJournal();
        const { jobs, create, ended } = setup(journal);
        const done = create(async (job) => {
            await sleep(20);
            job.emit({ type: "done", revision: job.context.chatRevision });
        });
        expect(jobs.live()).toBe(1);
        await ended(done);
        expect(jobs.live()).toBe(0);
        const failed = create(async () => {
            throw new GenerationRunnerError(429, "the provider said: secret", {
                stage: "request",
                requestId: ID,
                providerCode: "rate_limit_exceeded",
            });
        });
        await ended(failed);
        const marked = create(async () => {
            throw markFailure(new TypeError("secret"), { stage: "script" });
        });
        await ended(marked);
        const aborted = create(async (job) => {
            // The abort below may land before the runner starts.
            await new Promise<void>((resolve) => {
                if (job.signal.aborted) {
                    resolve();
                } else {
                    job.signal.addEventListener("abort", () => resolve());
                }
            });
        });
        expect(jobs.live()).toBe(1);
        expect(jobs.abort(aborted, "tab")).toBe(true);
        await ended(aborted);

        const recorded = journal.recent().filter((event) => event.kind === "job");
        expect(recorded.map((event) => [event.phase, event.jobId])).toEqual([
            ["accepted", done],
            ["done", done],
            ["accepted", failed],
            ["error", failed],
            ["accepted", marked],
            ["error", marked],
            ["accepted", aborted],
            ["error", aborted],
        ]);
        expect(recorded[0]).toEqual({ at: DAY_ONE, kind: "job", phase: "accepted", jobId: done, jobKind: "command" });
        expect(recorded[1]).toMatchObject({ phase: "done", jobKind: "command" });
        expect(recorded[1].durationMs).toBeGreaterThanOrEqual(15);
        expect(recorded[3]).toMatchObject({
            phase: "error",
            reason: "failed",
            status: 429,
            stage: "request",
            requestId: ID,
            providerCode: "rate_limit_exceeded",
        });
        expect(recorded[5]).toMatchObject({ phase: "error", reason: "failed", status: 500, stage: "script" });
        expect(recorded[5]).not.toHaveProperty("requestId");
        expect(recorded[7]).toMatchObject({ phase: "error", reason: "aborted" });
        expect(journal.state().recentJobFailures.map((event) => event.jobId)).toEqual([failed, marked]);
        const text = readFileSync(path.join(events, dayFile(DAY_ONE)), "utf8");
        expect(text).not.toContain("secret");
        expect(lines(path.join(events, dayFile(DAY_ONE)))).toHaveLength(8);
    });

    it("runs a job to its end when the diagnostics folder is broken (a file in its place) or the recorder throws", async () => {
        const root = tempDir();
        const asFile = path.join(root, "diag");
        writeFileSync(asFile, "a file");
        const journal = createDiagnosticsJournal({ dir: asFile, now: () => clock });
        cleanups.push(() => journal.close());
        const broken = setup(journal);
        const jobId = broken.create(async (job) => {
            job.emit({ type: "done", revision: job.context.chatRevision });
        });
        await broken.ended(jobId);
        expect(broken.jobs.status(jobId, "tab")).toMatchObject({ state: "ended" });
        expect(journal.recent().map((event) => event.phase)).toEqual(["accepted", "done"]);
        expect(journal.stats().writeFailures).toBe(3);
        expect(readFileSync(asFile, "utf8")).toBe("a file");

        const throwing = setup({
            record: () => {
                throw new Error("journal broke");
            },
        });
        const other = throwing.create(async (job) => {
            job.emit({ type: "done", revision: job.context.chatRevision });
        });
        await throwing.ended(other);
        expect(throwing.jobs.status(other, "tab")).toMatchObject({ state: "ended" });
    });
});

describe("the server context", () => {
    const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
        const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        try {
            await fn();
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    };

    it("creates `save/diagnostics/` with `events/` and `state.json` at creation, records `boot` first, and two contexts never share a folder", async () => {
        const a = createTestServer({ password: "pw" });
        const b = createTestServer({ password: "pw" });
        cleanups.push(
            () => a.close(),
            () => b.close(),
        );
        const dirA = path.join(a.savePath, "diagnostics");
        const dirB = path.join(b.savePath, "diagnostics");
        expect(readdirSync(dirA).sort()).toEqual(["events", "state.json"]);
        expect(readdirSync(dirB).sort()).toEqual(["events", "state.json"]);
        expect(readState(dirA)).toMatchObject({
            version: 1,
            app: { version: null },
            settings: { requestHistoryContent: true, requestHistoryLimit: 1000 },
            history: { rows: 0, bytes: 0 },
            workers: { workers: 0, busy: 0, queued: 0 },
            jobs: { live: 0 },
            recentJobFailures: [],
        });
        expect(a.context.diagnostics.recent()).toEqual([expect.objectContaining({ kind: "lifecycle", phase: "boot" })]);
        await a.app.request("/nowhere");
        expect(b.context.diagnostics.recent()).toHaveLength(1);
        expect(a.context.diagnostics.recent()).toHaveLength(2);
        const [fileA] = readdirSync(path.join(dirA, "events"));
        expect(lines(path.join(dirA, "events", fileA))).toHaveLength(2);
        const [fileB] = readdirSync(path.join(dirB, "events"));
        expect(lines(path.join(dirB, "events", fileB))).toHaveLength(1);
        if (posix) {
            expect(mode(dirA)).toBe(0o750);
            expect(mode(path.join(dirA, "state.json"))).toBe(0o640);
        }
    });

    it("reads `RISU_DIAGNOSTICS_DIR` against the root and `RISU_DIAGNOSTICS_MAX_BYTES` as a positive integer, and refuses another value", async () => {
        await withEnv({ RISU_DIAGNOSTICS_DIR: "var/diag", RISU_DIAGNOSTICS_MAX_BYTES: "4096" }, async () => {
            const s = createTestServer({ rootDir: makeRoot() });
            cleanups.push(() => s.close());
            expect(readdirSync(path.join(s.rootDir, "var", "diag")).sort()).toEqual(["events", "state.json"]);
            expect(existsSync(path.join(s.savePath, "diagnostics"))).toBe(false);
        });
        for (const value of ["0", "-1", "1.5", "64MiB", "Infinity"]) {
            await withEnv({ RISU_DIAGNOSTICS_MAX_BYTES: value }, () => {
                expect(() => createTestServer({ rootDir: makeRoot() }), value).toThrow(/RISU_DIAGNOSTICS_MAX_BYTES/);
            });
        }
        await withEnv({ RISU_DIAGNOSTICS_MAX_BYTES: "", RISU_DIAGNOSTICS_DIR: "" }, async () => {
            const s = createTestServer({ rootDir: makeRoot() });
            cleanups.push(() => s.close());
            expect(existsSync(path.join(s.savePath, "diagnostics", "state.json"))).toBe(true);
            expect(s.context.diagnostics.stats().eventBytes).toBeLessThan(DIAGNOSTICS_MAX_BYTES);
        });
    });

    it("records an `http` event for an answer of 400 or more with the registered template of the last handler that ran (`/*` for a miss, the route for its own auth, the handler's for a 500; a template outside `ROUTE_TEMPLATES` is left out), never for a success, never the URL", async () => {
        const s = createTestServer({ password: "pw" });
        cleanups.push(() => s.close());
        s.app.get("/boom/:secret", () => {
            throw new Error("boom");
        });
        expect((await s.app.request("/nowhere/private?x=1")).status).toBe(404);
        expect((await s.app.request("/api/request-history/alice?key=1")).status).toBe(400);
        expect((await s.app.request("/api/backups/alice/restore", { method: "POST" })).status).toBe(400);
        expect((await s.app.request("/boom/alice")).status).toBe(500);
        expect((await s.app.request("/api/read", { method: "PROPFIND" })).status).toBe(404);
        expect((await s.app.request("/")).status).toBe(200);
        expect((await s.app.request("/api/test_auth")).status).toBe(200);
        const events = s.context.diagnostics.recent().filter((event) => event.kind === "http");
        expect(events.map(({ at, durationMs, ...rest }) => rest)).toEqual([
            { kind: "http", method: "GET", route: "/*", status: 404 },
            { kind: "http", method: "GET", route: "/api/request-history/:id", status: 400 },
            { kind: "http", method: "POST", route: "/api/backups/:id/restore", status: 400 },
            // The test's own route is registered but not in the shared table: no route.
            { kind: "http", method: "GET", status: 500 },
            { kind: "http", route: "/*", status: 404 },
        ]);
        for (const event of events) {
            expect(event.durationMs).toBeGreaterThanOrEqual(0);
        }
        const [file] = readdirSync(path.join(s.savePath, "diagnostics", "events"));
        const text = readFileSync(path.join(s.savePath, "diagnostics", "events", file), "utf8");
        expect(text).not.toContain("alice");
        expect(text).not.toContain("private");
    });

    it("records maintenance start and end (with `replaced`) and `restore` only after a restore replaced the data", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        await s.create("characters", "a", { chaId: "a" });
        const snapshot = await s.context.snapshots.snapshotNow();
        const before = s.context.diagnostics.recent().length;
        expect((await s.request(`/api/backups/${snapshot.id}/restore`, { method: "POST" })).status).toBe(200);
        expect(
            s.context.diagnostics
                .recent()
                .slice(before)
                .map(({ at, ...rest }) => rest),
        ).toEqual([
            { kind: "lifecycle", phase: "maintenanceStart" },
            { kind: "lifecycle", phase: "maintenanceEnd", replaced: true },
            { kind: "lifecycle", phase: "restore" },
        ]);
        await s.readEpoch();
        // A refused snapshot replaces nothing: no `restore`, and a maintenance that ran ended unreplaced.
        const garbage = "resources-20300101T000000000Z-00000001";
        writeFileSync(path.join(s.savePath, "backups", `${garbage}.sqlite`), "garbage");
        const after = s.context.diagnostics.recent().length;
        expect((await s.request(`/api/backups/${garbage}/restore`, { method: "POST" })).status).toBe(400);
        const refused = s.context.diagnostics.recent().slice(after);
        expect(refused.map((event) => event.phase)).not.toContain("restore");
        for (const event of refused.filter((event) => event.phase === "maintenanceEnd")) {
            expect(event.replaced).toBe(false);
        }
    });

    it("records a job through the real wiring, and serves a request and a job when the diagnostics folder is a file", async () => {
        await withEnv({ RISU_DIAGNOSTICS_DIR: "broken" }, async () => {
            const root = makeRoot();
            writeFileSync(path.join(root, "broken"), "a file");
            const s = await createResourceTestClient({
                rootDir: root,
                generationRunner: async (job) => {
                    job.emit({ type: "done", revision: job.context.chatRevision });
                },
            });
            cleanups.push(() => s.close());
            expect(readFileSync(path.join(root, "broken"), "utf8")).toBe("a file");
            expect(s.context.diagnostics.stats().writeFailures).toBeGreaterThan(0);
            const jobId = await createCommandJob(s);
            await waitFor(() => s.context.diagnostics.recent().some((event) => event.phase === "done"));
            expect(await (await s.request(`/api/generations/${jobId}?clientId=tab`)).json()).toMatchObject({
                state: "ended",
            });
            expect(s.context.diagnostics.recent().filter((event) => event.kind === "job")).toEqual([
                expect.objectContaining({ phase: "accepted", jobId, jobKind: "command" }),
                expect.objectContaining({ phase: "done", jobId, jobKind: "command" }),
            ]);
            expect(warnings()).toHaveLength(1);
        });
    });

    it("records `shutdown` and writes the final state at dispose after the admitted work ended, while the stores are open; a later dispose changes nothing", async () => {
        const s = await createResourceTestClient({ snapshotIntervalMs: 60_000 });
        const dir = path.join(s.savePath, "diagnostics");
        const { rootDir, context } = s;
        cleanups.push(() => rmSync(rootDir, { recursive: true, force: true }));
        await s.create("characters", "a", { chaId: "a" });
        context.startBackgroundTasks();
        const first = readState(dir);
        await sleep(5);
        await context.dispose();
        const events = context.diagnostics.recent();
        expect(events.at(-1)).toMatchObject({ kind: "lifecycle", phase: "shutdown" });
        const final = readState(dir);
        expect(final.writtenAt).not.toBe(first.writtenAt);
        // The settings come from the resource store and the counts from the history: both open at the write.
        expect(final).toMatchObject({
            settings: { requestHistoryContent: true, requestHistoryLimit: 1000 },
            history: { rows: 0, bytes: 0 },
            jobs: { live: 0 },
        });
        expect(context.diagnostics.stats().writeFailures).toBe(0);
        const [file] = readdirSync(path.join(dir, "events"));
        expect(lines(path.join(dir, "events", file)).at(-1)).toMatchObject({ kind: "lifecycle", phase: "shutdown" });
        await context.dispose();
        expect(readState(dir).writtenAt).toBe(final.writtenAt);
    });
});

describe("the read route and the route table", () => {
    it("answers the ring and the state to a JWT with `no-store` (a trailing slash too), the server's 400 with `no-store` without one, and writes nothing", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        const dir = path.join(s.savePath, "diagnostics");
        const denied = await s.app.request("/api/diagnostics");
        expect(denied.status).toBe(400);
        expect(denied.headers.get("cache-control")).toBe("no-store");
        // The 400 is an `http` event of the journal (a missing token is the server's 400 on every authenticated route); from here on nothing is written.
        const folder = () => ({
            state: readFileSync(path.join(dir, "state.json"), "utf8"),
            events: sizes(path.join(dir, "events")),
        });
        const before = folder();
        const res = await s.request("/api/diagnostics");
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = (await res.json()) as { events: DiagnosticEvent[]; state: Record<string, unknown> };
        expect(body.events).toEqual(s.context.diagnostics.recent());
        expect(body.events[0]).toMatchObject({ kind: "lifecycle", phase: "boot" });
        expect(body.events.at(-1)).toMatchObject({
            kind: "http",
            method: "GET",
            route: "/api/diagnostics",
            status: 400,
        });
        expect(Object.keys(body.state).sort()).toEqual(Object.keys(s.context.diagnostics.state()).sort());
        expect(body.state.journal).toEqual({ eventBytes: expect.any(Number), writeFailures: 0 });
        const slash = await s.request("/api/diagnostics/");
        expect(slash.status).toBe(200);
        expect(slash.headers.get("cache-control")).toBe("no-store");
        expect(((await slash.json()) as { events: unknown[] }).events).toEqual(body.events);
        expect(folder()).toEqual(before);
    });

    it("refuses the read with a 503 (`Retry-After`, `no-store`) once shutdown began, as the admission middleware does for the history", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        await s.context.dispose();
        const res = await s.request("/api/diagnostics");
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBe("5");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ error: "The server is shutting down" });
    });

    it("has every registered route in `ROUTE_TEMPLATES`, so the browser's `apiRouteTemplate` and the server's `http` events name the same templates", () => {
        const s = createTestServer({ password: "pw" });
        cleanups.push(() => s.close());
        const registered = [...new Set(s.app.routes.map((route) => route.path))];
        expect(registered.length).toBeGreaterThan(30);
        expect(registered.filter((route) => !(ROUTE_TEMPLATES as readonly string[]).includes(route))).toEqual([]);
        // What the table holds beyond the server's routes: the service worker's, and `?`.
        expect(ROUTE_TEMPLATES.filter((template) => !registered.includes(template))).toEqual([
            "/sw/init",
            "/sw/check/*",
            "/sw/img/*",
            "/sw/register/*",
            "/sw/share/*",
            "?",
        ]);
    });
});

/** A report-named regular file in `reports/`: the stamp of `at` and `hex` (the save of that clock). */
const reportName = (at: number, hex: string) => `${new Date(at).toISOString().replace(/[-:.]/g, "")}-${hex}.txt`;
const reportInput = (server: unknown) => ({
    meta: {
        version: "2026.8.250",
        browser: "Chrome",
        os: "Linux",
        online: true,
        viewport: { width: 1280, height: 720 },
        exportedAt: DAY_ONE,
    },
    server: server as { state: unknown; events: unknown } | null,
    browser: [{ at: DAY_ONE - 1000, kind: "page", phase: "boot" }] as unknown[],
});
/** The report of a journal's own state and ring: what the panel would build from `GET /api/diagnostics`. */
const reportOf = (journal: ReturnType<typeof createDiagnosticsJournal>) =>
    buildDiagnosticReport(reportInput({ state: journal.state(), events: journal.recent() }));
const PRIVATE = "Private Character said hello";

describe("the report journal", () => {
    it("saves a report as `reports/<UTC stamp>-<8 hex>.txt` (the folder 0750, the file 0640), whole, with no temp file left, and keeps the state's shape", () => {
        const { dir, journal } = openJournal();
        const reports = path.join(dir, "reports");
        expect(existsSync(reports)).toBe(false);
        const text = reportOf(journal);
        expect(canonicalDiagnosticReport(text)).toBe(text);
        const saved = journal.saveReport(text);
        expect(saved).toEqual({ ok: true, name: expect.stringMatching(REPORT_FILE_PATTERN) });
        const name = (saved as { name: string }).name;
        expect(name.startsWith(reportName(DAY_ONE, "").slice(0, -4))).toBe(true);
        expect(readdirSync(reports)).toEqual([name]);
        expect(readFileSync(path.join(reports, name), "utf8")).toBe(text);
        if (posix) {
            expect(mode(reports)).toBe(0o750);
            expect(mode(path.join(reports, name))).toBe(0o640);
        }
        const again = journal.saveReport(text) as { ok: true; name: string };
        expect(again.ok).toBe(true);
        expect(again.name).not.toBe(name);
        expect(readdirSync(reports).sort()).toEqual([name, again.name].sort());
        expect(journal.stats().writeFailures).toBe(0);
        expect(Object.keys(journal.state())).not.toContain("reports");
        expect(readdirSync(dir).sort()).toEqual(["events", "reports"]);
    });

    it("refuses a non-string or a text over 1 MiB without touching the folder or counting a write failure", () => {
        const { dir, journal } = openJournal();
        expect(journal.saveReport(undefined as unknown as string)).toEqual({ ok: false });
        expect(journal.saveReport("x".repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1))).toEqual({ ok: false });
        // Under the limit in characters, over it in bytes.
        expect(journal.saveReport("é".repeat(MAX_DIAGNOSTIC_REPORT_BYTES / 2 + 1))).toEqual({ ok: false });
        expect(existsSync(path.join(dir, "reports"))).toBe(false);
        expect(journal.stats().writeFailures).toBe(0);
        expect(journal.saveReport("x".repeat(MAX_DIAGNOSTIC_REPORT_BYTES))).toMatchObject({ ok: true });
    });

    it("keeps the newest 50 reports by name after a save, never the one just saved (a clock set back), and leaves every other entry alone", () => {
        vi.spyOn(process, "uptime").mockReturnValue(123);
        const { dir, journal } = openJournal();
        const reports = path.join(dir, "reports");
        mkdirSync(reports);
        const older = Array.from({ length: 50 }, (_, i) =>
            reportName(DAY_ONE - (100 - i) * 60_000, "0000000" + i.toString(16).slice(-1)),
        );
        for (const name of older) {
            writeFileSync(path.join(reports, name), "old");
        }
        const noise = [
            "notes.txt",
            ".report-deadbeef.tmp",
            reportName(DAY_ONE - 200 * 60_000, "aaaaaaaa").replace(".txt", ".log"),
        ];
        for (const name of noise) {
            writeFileSync(path.join(reports, name), "mine");
        }
        const dirLike = reportName(DAY_ONE - 300 * 60_000, "bbbbbbbb");
        mkdirSync(path.join(reports, dirLike));
        const linkLike = reportName(DAY_ONE - 400 * 60_000, "cccccccc");
        symlinkSync(path.join(reports, older[49]), path.join(reports, linkLike));
        const fifoLike = reportName(DAY_ONE - 500 * 60_000, "dddddddd");
        if (posix) {
            execFileSync("mkfifo", [path.join(reports, fifoLike)]);
        }
        const untouched = () => [...noise, dirLike, linkLike, ...(posix ? [fifoLike] : [])];
        const regular = () =>
            readdirSync(reports, { withFileTypes: true })
                .filter((entry) => entry.isFile() && REPORT_FILE_PATTERN.test(entry.name))
                .map((entry) => entry.name)
                .sort();

        const first = journal.saveReport(reportOf(journal)) as { ok: true; name: string };
        expect(first.ok).toBe(true);
        expect(regular()).toEqual([...older.slice(1), first.name]);
        for (const name of untouched()) {
            expect(existsSync(path.join(reports, name)) || lstatSync(path.join(reports, name)).isSymbolicLink()).toBe(
                true,
            );
        }
        expect(readFileSync(path.join(reports, "notes.txt"), "utf8")).toBe("mine");
        expect(readFileSync(path.join(reports, older[49]), "utf8")).toBe("old");

        // The clock set back: the new report's name sorts before every other, and it is the one kept.
        clock = DAY_ONE - 1000 * 60_000;
        const early = journal.saveReport(reportOf(journal)) as { ok: true; name: string };
        expect(early.ok).toBe(true);
        expect(readFileSync(path.join(reports, early.name), "utf8")).toBe(reportOf(journal));
        expect(regular()).toEqual([early.name, ...older.slice(2), first.name]);
        expect(journal.stats().writeFailures).toBe(0);
        for (const name of untouched()) {
            expect(lstatSync(path.join(reports, name))).toBeTruthy();
        }
    });

    it("prunes `reports/` at creation to the newest 50 regular report files, leaving other entries alone, and makes no `reports/` when there is none", () => {
        const root = tempDir();
        const dir = path.join(root, "diag");
        const reports = path.join(dir, "reports");
        mkdirSync(reports, { recursive: true });
        const names = Array.from({ length: 55 }, (_, i) => reportName(DAY_ONE + i * 1000, "00000000"));
        for (const name of names) {
            writeFileSync(path.join(reports, name), "old");
        }
        writeFileSync(path.join(reports, "keep.txt"), "mine");
        const link = reportName(DAY_ONE - 1000, "ffffffff");
        symlinkSync(path.join(reports, "keep.txt"), path.join(reports, link));
        const journal = createDiagnosticsJournal({ dir, now: () => clock });
        cleanups.push(() => journal.close());
        expect(readdirSync(reports).sort()).toEqual([...names.slice(5), "keep.txt", link].sort());
        expect(readFileSync(path.join(reports, "keep.txt"), "utf8")).toBe("mine");
        expect(journal.stats().writeFailures).toBe(0);

        const fresh = openJournal();
        expect(readdirSync(fresh.dir)).toEqual(["events"]);
        expect(fresh.journal.stats().writeFailures).toBe(0);
    });

    it("refuses a symlinked `reports/` or a regular file in its place: nothing is written or pruned through it, the failure counted and warned once with its code", () => {
        const { root, dir, journal } = openJournal();
        const elsewhere = path.join(root, "elsewhere");
        mkdirSync(elsewhere);
        for (let i = 0; i < 60; i++) {
            writeFileSync(path.join(elsewhere, reportName(DAY_ONE + i * 1000, "00000000")), "theirs");
        }
        symlinkSync(elsewhere, path.join(dir, "reports"), "dir");
        expect(journal.saveReport(reportOf(journal))).toEqual({ ok: false });
        expect(journal.stats().writeFailures).toBe(1);
        expect(readdirSync(elsewhere)).toHaveLength(60);
        expect(lstatSync(path.join(dir, "reports")).isSymbolicLink()).toBe(true);
        expect(warnings()).toEqual([[WARNING, "ESYMLINK"]]);
        // At creation too (the startup prune), and a regular file in its place.
        const linked = createDiagnosticsJournal({ dir, now: () => clock });
        cleanups.push(() => linked.close());
        expect(linked.stats().writeFailures).toBe(1);
        expect(readdirSync(elsewhere)).toHaveLength(60);

        const asFile = openJournal();
        writeFileSync(path.join(asFile.dir, "reports"), "not a directory");
        expect(asFile.journal.saveReport(reportOf(asFile.journal))).toEqual({ ok: false });
        expect(asFile.journal.stats().writeFailures).toBe(1);
        expect(readFileSync(path.join(asFile.dir, "reports"), "utf8")).toBe("not a directory");
        // `state.json` is still written beside it.
        asFile.journal.writeState();
        expect(readState(asFile.dir)).toMatchObject({ journal: { writeFailures: 1 } });
    });

    it("never deletes an entry it did not create: a temp name already taken fails the write (one counted failure), the entry kept as it was; for `state.json` too", () => {
        const { dir, journal } = openJournal();
        const reports = path.join(dir, "reports");
        mkdirSync(reports);
        writeFileSync(path.join(reports, ".report-0badf00d.tmp"), "theirs");
        randomQueue.push("01234567", "0badf00d");
        expect(journal.saveReport(reportOf(journal))).toEqual({ ok: false });
        expect(randomQueue).toEqual([]);
        expect(readdirSync(reports)).toEqual([".report-0badf00d.tmp"]);
        expect(readFileSync(path.join(reports, ".report-0badf00d.tmp"), "utf8")).toBe("theirs");
        expect(journal.stats().writeFailures).toBe(1);
        expect(warnings()).toEqual([[WARNING, "EEXIST"]]);

        writeFileSync(path.join(dir, ".state-0badf00d.tmp"), "theirs");
        randomQueue.push("0badf00d");
        journal.writeState();
        expect(readFileSync(path.join(dir, ".state-0badf00d.tmp"), "utf8")).toBe("theirs");
        expect(existsSync(path.join(dir, "state.json"))).toBe(false);
        expect(journal.stats().writeFailures).toBe(2);
        // A name that is free works, and the stray temp files stay.
        journal.writeState();
        expect(readState(dir)).toMatchObject({ journal: { writeFailures: 2 } });
        expect(readdirSync(dir).sort()).toEqual([".state-0badf00d.tmp", "events", "reports", "state.json"]);
    });

    it("draws a report name again when it is taken (a symlink there too), up to three times, then counts one `EEXIST` failure; nothing taken is replaced", () => {
        const { dir, journal } = openJournal();
        const reports = path.join(dir, "reports");
        mkdirSync(reports);
        const taken = ["aaaaaaaa", "bbbbbbbb", "cccccccc"].map((hex) => reportName(DAY_ONE, hex));
        writeFileSync(path.join(reports, taken[0]), "theirs");
        symlinkSync(path.join(dir, "events"), path.join(reports, taken[1]));
        randomQueue.push("aaaaaaaa", "bbbbbbbb", "cccccccc");
        const text = reportOf(journal);
        expect(journal.saveReport(text)).toEqual({ ok: true, name: taken[2] });
        expect(readFileSync(path.join(reports, taken[2]), "utf8")).toBe(text);
        expect(readFileSync(path.join(reports, taken[0]), "utf8")).toBe("theirs");
        expect(lstatSync(path.join(reports, taken[1])).isSymbolicLink()).toBe(true);
        expect(journal.stats().writeFailures).toBe(0);

        randomQueue.push("aaaaaaaa", "bbbbbbbb", "cccccccc");
        expect(journal.saveReport(text)).toEqual({ ok: false });
        expect(randomQueue).toEqual([]);
        expect(journal.stats().writeFailures).toBe(1);
        expect(warnings()).toEqual([[WARNING, "EEXIST"]]);
        expect(readdirSync(reports).sort()).toEqual([...taken].sort());
        expect(readFileSync(path.join(reports, taken[2]), "utf8")).toBe(text);
        expect(readFileSync(path.join(reports, taken[0]), "utf8")).toBe("theirs");
    });

    it("keeps a save whose prune failed (the failure counted) and prunes the excess at the next save", () => {
        const { dir, journal } = openJournal();
        const reports = path.join(dir, "reports");
        mkdirSync(reports);
        const older = Array.from({ length: 50 }, (_, i) => reportName(DAY_ONE - (100 - i) * 60_000, "00000000"));
        for (const name of older) {
            writeFileSync(path.join(reports, name), "old");
        }
        fsOverrides.unlinkSync = () => {
            throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
        };
        const text = reportOf(journal);
        const saved = journal.saveReport(text) as { ok: true; name: string };
        fsOverrides.unlinkSync = null;
        expect(saved.ok).toBe(true);
        expect(readFileSync(path.join(reports, saved.name), "utf8")).toBe(text);
        expect(readdirSync(reports)).toHaveLength(51);
        expect(journal.stats().writeFailures).toBe(1);
        expect(warnings()).toEqual([[WARNING, "EPERM"]]);
        const next = journal.saveReport(text) as { ok: true; name: string };
        expect(next.ok).toBe(true);
        // The two saves share a stamp (the test clock): their order is the random suffix's.
        expect(readdirSync(reports).sort()).toEqual([...older.slice(2), saved.name, next.name].sort());
        expect(journal.stats().writeFailures).toBe(1);
    });
});

describe("the report route", () => {
    const post = (
        s: Awaited<ReturnType<typeof createResourceTestClient>>,
        body: RequestInit["body"],
        init: RequestInit = {},
    ) =>
        s.request("/api/diagnostics/report", {
            method: "POST",
            headers: { "content-type": "text/plain; charset=utf-8", ...(init.headers as Record<string, string>) },
            ...init,
            body,
        });
    /** The report the panel would build from the server's own `GET /api/diagnostics`. */
    const reportFrom = async (s: Awaited<ReturnType<typeof createResourceTestClient>>) => {
        const res = await s.request("/api/diagnostics");
        expect(res.status).toBe(200);
        return buildDiagnosticReport(reportInput(await res.json()));
    };
    const reportsDir = (s: { savePath: string }) => path.join(s.savePath, "diagnostics", "reports");
    /** Every console line since the test began (all three are spied). */
    const logged = () =>
        [warn, ...(["error", "log"] as const).map((name) => console[name] as unknown as ReturnType<typeof vi.spyOn>)]
            .flatMap((spy) => spy.mock.calls as unknown[][])
            .map((call) => call.map(String).join(" "));

    it("saves a canonical report to `reports/` and answers its name with `no-store` (a trailing slash too); the file holds the text as sent", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        const text = await reportFrom(s);
        expect(text).toContain("\nServer: current\n");
        const res = await post(s, text);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const { name } = (await res.json()) as { name: string };
        expect(name).toMatch(REPORT_FILE_PATTERN);
        expect(readdirSync(reportsDir(s))).toEqual([name]);
        expect(readFileSync(path.join(reportsDir(s), name), "utf8")).toBe(text);
        if (posix) {
            expect(mode(reportsDir(s))).toBe(0o750);
            expect(mode(path.join(reportsDir(s), name))).toBe(0o640);
        }
        // A report built by hand in the format passes too (the check is of shape); a content type is not required.
        const browserOnly = buildDiagnosticReport(reportInput(null));
        const slash = await s.request("/api/diagnostics/report/", { method: "POST", body: browserOnly });
        expect(slash.status).toBe(200);
        expect(slash.headers.get("cache-control")).toBe("no-store");
        const second = ((await slash.json()) as { name: string }).name;
        expect(readFileSync(path.join(reportsDir(s), second), "utf8")).toBe(browserOnly);
        expect(s.context.diagnostics.stats().writeFailures).toBe(0);
    });

    it("refuses a body that is not the report's canonical text with a 400 (`no-store`), writes nothing, and never logs the text", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        const text = await reportFrom(s);
        const refused = async (body: string) => {
            const res = await post(s, body);
            expect(res.status).toBe(400);
            expect(res.headers.get("cache-control")).toBe("no-store");
            expect(await res.json()).toEqual({ error: "Not a diagnostic report" });
        };
        await refused(`${PRIVATE}\n`);
        await refused("");
        await refused(text.replace("Online: true", `Online: true ${PRIVATE}`));
        await refused(text.replace(/\n/g, "\r\n"));
        await refused(text.replace('"phase":"boot"', `"phase":"boot","message":"${PRIVATE}"`));
        await refused(text.slice(0, -1));
        expect(existsSync(reportsDir(s))).toBe(false);
        expect(logged().some((line) => line.includes(PRIVATE) || line.includes("Metatron diagnostic"))).toBe(false);
        // The refusals are `http` events with the route's template, never the text.
        const events = s.context.diagnostics.recent().filter((event) => event.route === "/api/diagnostics/report");
        expect(events).toHaveLength(6);
        expect(events[0]).toMatchObject({ kind: "http", method: "POST", status: 400 });
        expect(JSON.stringify(s.context.diagnostics.recent())).not.toContain(PRIVATE);
        // Without a JWT: the server's own 400, and nothing written.
        const denied = await s.app.request("/api/diagnostics/report", { method: "POST", body: text });
        expect(denied.status).toBe(400);
        expect(denied.headers.get("cache-control")).toBe("no-store");
        expect(existsSync(reportsDir(s))).toBe(false);
    });

    it("answers 400, not 500, when the report stream fails without a declared length", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        const res = await post(
            s,
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("Metatron diagnostic"));
                    controller.error(new DOMException("The client went away", "AbortError"));
                },
            }),
            { duplex: "half" } as RequestInit,
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Could not read the report" });
    });

    it("refuses a body over 1 MiB with a 413 (`no-store`): by its declared length, by its streamed bytes, and by its actual bytes under a wrong declared length; one of 1 MiB passes", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        const over = "x".repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1);
        const tooLarge = async (res: Response) => {
            expect(res.status).toBe(413);
            expect(res.headers.get("cache-control")).toBe("no-store");
            expect(await res.json()).toEqual({ error: "Request body too large" });
        };
        await tooLarge(await post(s, over, { headers: { "content-length": String(over.length) } }));
        const chunks = [over.slice(0, 1000), over.slice(1000)];
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(new TextEncoder().encode(chunk));
                }
                controller.close();
            },
        });
        await tooLarge(await post(s, stream, { duplex: "half" } as RequestInit));
        // A declared length the limiter trusts, with more bytes behind it: the body read is measured again.
        await tooLarge(await post(s, over, { headers: { "content-length": "1" } }));
        // Under the limit in characters, over it in bytes.
        await tooLarge(
            await post(s, "é".repeat(MAX_DIAGNOSTIC_REPORT_BYTES / 2 + 1), { headers: { "content-length": "1" } }),
        );
        expect(existsSync(reportsDir(s))).toBe(false);
        // A report the builder cut to the cap is at most 1 MiB and passes.
        const stack = Array.from({ length: 8 }, (_, i) => `shared/${"a".repeat(195)}${i}.ts:1234567:1234567`);
        const answer = (await (await s.request("/api/diagnostics")).json()) as { state: unknown };
        const input = reportInput({
            state: answer.state,
            events: Array.from({ length: 300 }, (_, i) => ({
                at: DAY_ONE + i,
                kind: "runtime",
                origin: "dispose",
                stack,
            })),
        });
        input.browser = Array.from({ length: 300 }, (_, i) => ({
            at: DAY_ONE + i,
            kind: "runtime",
            origin: "error",
            stack,
        }));
        const text = buildDiagnosticReport(input);
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_DIAGNOSTIC_REPORT_BYTES);
        expect(text).not.toContain("Omitted events: 0\n");
        const res = await post(s, text);
        expect(res.status).toBe(200);
        const { name } = (await res.json()) as { name: string };
        expect(readFileSync(path.join(reportsDir(s), name), "utf8")).toBe(text);
    });

    it("refuses the save with a 503 once shutdown began: at admission, and again after a body read that outlasted the admission, with nothing saved", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        const text = await reportFrom(s);
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let pulled = false;
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (pulled) {
                    controller.close();
                    return;
                }
                pulled = true;
                await released;
                controller.enqueue(new TextEncoder().encode(text));
            },
        });
        const pending = post(s, stream, { duplex: "half" } as RequestInit);
        await waitFor(() => pulled);
        s.context.beginShutdown();
        release();
        const res = await pending;
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBe("5");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ error: "The server is shutting down" });
        expect(existsSync(reportsDir(s))).toBe(false);
        const admission = await post(s, text);
        expect(admission.status).toBe(503);
        expect(admission.headers.get("cache-control")).toBe("no-store");
        expect(existsSync(reportsDir(s))).toBe(false);
    });

    it("answers 500 (`no-store`) when the report cannot be written (a file in place of `reports/`), the failure counted", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        writeFileSync(reportsDir(s), "not a directory");
        const text = await reportFrom(s);
        const res = await post(s, text);
        expect(res.status).toBe(500);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ error: "Could not save the report" });
        expect(readFileSync(reportsDir(s), "utf8")).toBe("not a directory");
        expect(s.context.diagnostics.stats().writeFailures).toBe(1);
        expect(logged().some((line) => line.includes("Metatron diagnostic"))).toBe(false);
    });
});

/** Seeds one bound chat and creates a command job for it over the routes; returns the job id. */
async function createCommandJob(s: Awaited<ReturnType<typeof createResourceTestClient>>): Promise<string> {
    const firstId = async (kind: string) =>
        ((await (await s.request(`/api/resources/${kind}/main`)).json()) as { data: { id: string }[] }).data[0].id;
    const bound = {
        presetId: await firstId("presets"),
        modelPresetId: await firstId("modelPresets"),
        personaId: await firstId("personas"),
    };
    const seeded = await s.json("/api/resources/batch", {
        ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            name: "K",
                            modelPresetId: bound.modelPresetId,
                            promptPresetId: bound.presetId,
                            bindedPersona: bound.personaId,
                            message: [{ role: "user", data: "hi", chatId: "u" }],
                        },
                    },
                ],
            },
        ],
    });
    expect(seeded.status).toBe(200);
    const read = (await (await s.json("/api/resources/read", { chats: [{ characterId: "c", id: "k" }] })).json()) as {
        chats: { revision: string }[];
    };
    const res = await s.json("/api/generations", {
        kind: "command",
        context: {
            characterId: "c",
            chatId: "k",
            ...bound,
            mode: "normal",
            input: "",
            chatRevision: read.chats[0].revision,
        },
        clientId: "tab",
        command: { type: "button", data: "" },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { jobId: string }).jobId;
}
