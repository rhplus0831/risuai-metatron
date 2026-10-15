// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
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
import { encodeSecretPath } from "../../../shared/llmSecrets.ts";
import {
    REQUEST_HISTORY_PATH,
    REQUEST_HISTORY_SHARE_PATH,
    REQUEST_HISTORY_SHARES_PATH,
    type RequestHistoryShareResult,
} from "../../../shared/requestHistory.ts";
import { createRequestHistory, type RequestHistory, type RequestHistoryBegin } from "../data/requestHistory.ts";
import type { DiagnosticEvent } from "../../../shared/diagnostics.ts";
import { createDiagnosticsJournal, type SaveReportResult } from "../diagnostics/journal.ts";
import { createRequestShares, SHARE_FORMAT } from "../diagnostics/share.ts";
import { REDACTED } from "../llm/redact.ts";
import { loadStoredSecrets } from "../llm/settings.ts";
import { SHARE_BODY_BYTES } from "../routes/requestHistory.ts";
import { createResourceTestClient, waitFor } from "./testSupport.ts";

// Request history slice 10 (`docs/plan/request-history-diagnostics.md`, decisions 3, 4, and 9,
// "Sharing to the folder"): a job's requests shared to the diagnostics folder's `shared/`
// (`server/src/diagnostics/share.ts`), the journal's `shared/` operations and `eventsFor`
// (`server/src/diagnostics/journal.ts`), the store's share reads (`readShare`, `shareTargetOf`,
// `clearShared`), the credentials of the second redaction (`loadStoredSecrets`), and the routes
// on the real app. The copy: one file per share named by the target, the rows oldest first with a
// content-off row as its summary only, the head's checked `app.version`, the job's events and its
// last error as `failure`. The second redaction: every stored credential (a named key the
// collection no longer names, an id of `__proto__`) replaced in every string, headers masked by
// name, a trailing credential start trimmed from every cut field (a summary field, an exchange's
// metadata, a summary-only row) and from every response; a credential set that cannot be read
// shares nothing. The protocol: a re-share lands beside the old copy and replaces it only once the
// rows are marked (a failed mark removes the new copy, a failed removal of the old one answers 500
// and keeps both); a withdrawal removes the files, then the marks, also for a job whose rows the
// caps removed. The folder: only share-named regular files counted, listed, or removed; a temp file
// of a share cut short removed at creation and with its target; a symlinked or non-directory
// `shared/` refused everywhere; `state.json` written after every change. `eventsFor`: the day files
// and the ring without duplicates, oldest first, partial for a refused day entry, an unterminated
// tail, a malformed line, or a line over 64 KiB. The routes: the strict body and its own 4 KiB
// limit, 404, 503 at shutdown after the body read, `GET` shares (also after a prune), and "Delete
// all" removing the shares first and nothing when one stays.

const posix = process.platform !== "win32";
const JOB = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
const OTHER_JOB = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const TRANSLATION = `translate-${OTHER_JOB}`;
const REQ = (n: number) => `1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c${n.toString(16).padStart(2, "0")}`;
const SECRET = "demo-secret-abcdef";
/** The secret's start a cut leaves behind (the stored 1 KiB of a display field ends in it). */
const PREFIX = "demo-secret-abc";
const KIB = 1024;
/** 2026-10-15T12:00:00Z. */
const NOON = Date.UTC(2026, 9, 15, 12);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
let clock = NOON;

const cleanups: (() => Promise<void> | void)[] = [];
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    clock = NOON;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
    vi.restoreAllMocks();
});

function tempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-request-share-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** A store, a journal in `<temp>/diag`, and the share module over them (the test clock, the given secrets). */
function open(options: { secrets?: () => string[]; now?: () => number; limit?: () => number } = {}) {
    const root = tempDir();
    const history = createRequestHistory({
        file: path.join(root, "history.sqlite"),
        now: () => clock,
        limit: options.limit ?? (() => 1000),
    });
    const dir = path.join(root, "diag");
    const journal = createDiagnosticsJournal({ dir, now: () => clock, sources: { appVersion: () => "2026.10.1" } });
    cleanups.push(() => {
        journal.close();
        history.close();
    });
    const shares = createRequestShares({
        history,
        journal,
        secrets: options.secrets ?? (() => [SECRET]),
        now: options.now ?? (() => clock),
    });
    return { root, dir, shared: path.join(dir, "shared"), events: path.join(dir, "events"), history, journal, shares };
}

function row(id: string, overrides: Partial<RequestHistoryBegin> = {}): RequestHistoryBegin {
    return {
        id,
        jobId: JOB,
        source: "send",
        mode: "main",
        chaId: null,
        chatId: null,
        messageId: null,
        content: true,
        ...overrides,
    };
}

/** Two finished rows of `JOB` (the second with content off), each a second apart, plus a standalone one. */
function seed(history: RequestHistory) {
    history.begin(row(REQ(1)));
    history.setPrompt(REQ(1), JSON.stringify([{ role: "user", content: `hi ${SECRET}` }]));
    history.describe(REQ(1), { modelId: "gpt-5", provider: "OpenAI", profileName: "Main" });
    history.exchange(REQ(1), {
        url: `https://api.example/v1?key=${SECRET}&x=1`,
        header: JSON.stringify({ Authorization: `Bearer ${SECRET}`, "x-trace": "t" }),
        body: JSON.stringify({ q: SECRET }),
        response: `ok ${JSON.stringify(SECRET).slice(1, -1)} tail ${PREFIX}`,
        success: true,
        status: 200,
        date: "2026-10-15T12:00:00.000Z",
        responseType: "text/event-stream",
    });
    history.finish(REQ(1), { status: "success", httpStatus: 200, error: null });
    clock += 1000;
    history.begin(row(REQ(2), { content: false }));
    history.finish(REQ(2), { status: "error", httpStatus: 500, error: `boom ${SECRET}`, providerCode: "overloaded" });
    clock += 1000;
    history.begin(row(REQ(3), { jobId: null }));
    history.finish(REQ(3), { status: "success" });
    clock += 1000;
}

const shareFiles = (shared: string) => (existsSync(shared) ? readdirSync(shared).sort() : null);
const readShare = (shared: string, name: string) => JSON.parse(readFileSync(path.join(shared, name), "utf8"));
const stateOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as { shared: unknown };
const stamp = (at: number) => new Date(at).toISOString().replace(/[-:.]/g, "");
/** A save's result as a landed one (the test asserts `ok` right after). */
const saved = (result: SaveReportResult) => result as { ok: true; name: string };

describe("loadStoredSecrets", () => {
    type Named = Record<string, { key: string }>;
    /** A resource store answering the three records (`null` for a missing one). */
    const store = (records: { providers?: unknown; llmSecrets?: unknown; credentials?: unknown }) =>
        ({
            readRefs: (refs: { kind: { name: string } }[]) => ({
                items: refs.map((ref) => ({ data: (records as Record<string, unknown>)[ref.kind.name] ?? null })),
            }),
        }) as never;
    const kinds = { get: (name: string) => ({ name }) } as never;
    const secrets = (named: Named, credentials: unknown = [], providers: unknown = {}) =>
        loadStoredSecrets(
            store({
                providers,
                // As the resource store reads the record back: an own `__proto__` key stays one.
                llmSecrets: JSON.parse(JSON.stringify({ openAIKey: "sk-open", credentials: named })),
                credentials,
            }),
            kinds,
        );

    it("collects every named key of the `llmSecrets` map (one the collection no longer names, one whose id is `__proto__`), the collection's client emails, and the flat keys", () => {
        expect(secrets({ named: { key: "sk-named" } }, [{ id: "named", name: "N", type: "custom" }])).toEqual([
            "sk-open",
            "sk-named",
            "sk-named",
        ]);
        // An orphaned key (its collection record deleted) is still stored, so it is still redacted.
        expect(secrets({ orphan: { key: "sk-orphan" } }, [])).toContain("sk-orphan");
        const proto = secrets({ ["__proto__"]: { key: "sk-proto" } }, [
            { id: "__proto__", name: "P", type: "vertex", clientEmail: "svc@example.iam" },
        ]);
        expect(proto).toContain("sk-proto");
        expect(proto).toContain("svc@example.iam");
        // A client email whose key is gone is still a credential.
        expect(secrets({}, [{ id: "mail-only", name: "M", type: "vertex", clientEmail: "only@example.iam" }])).toEqual([
            "sk-open",
            "only@example.iam",
        ]);
        expect(secrets({ bedrock: { key: "AKIA:wJalr:us-east-1" } })).toEqual(
            expect.arrayContaining(["AKIA:wJalr:us-east-1", "AKIA", "wJalr", "us-east-1"]),
        );
        expect(secrets({}, [], { openAIKey: "ignored: providers has no key fields" })).toEqual(["sk-open"]);
    });

    it("throws when a record is missing or malformed (the credentials collection not an array included), so nothing is redacted with an empty set by mistake; an empty collection is fine", () => {
        expect(() => loadStoredSecrets(store({ llmSecrets: {}, credentials: [] }), kinds)).toThrow(
            /no settings records/,
        );
        expect(() => loadStoredSecrets(store({ providers: {}, credentials: [] }), kinds)).toThrow(
            /no settings records/,
        );
        expect(() => loadStoredSecrets(store({ providers: {}, llmSecrets: {} }), kinds)).toThrow(/no settings records/);
        expect(() => loadStoredSecrets(store({ providers: {}, llmSecrets: {}, credentials: {} }), kinds)).toThrow(
            /no settings records/,
        );
        expect(loadStoredSecrets(store({ providers: {}, llmSecrets: {}, credentials: [] }), kinds)).toEqual([]);
        expect(() => loadStoredSecrets(store({}), { get: () => undefined } as never)).toThrow(/Unknown resource kind/);
    });
});

describe("the share module: the copy", () => {
    it("shares a request's whole job as `shared/<stamp>-job-<id>.json` (0640): the head with the checked app version, the rows oldest first (a content-off row its summary only), the job's events and its last error, the rows marked, the state counting the file", () => {
        const { dir, shared, history, journal, shares } = open();
        seed(history);
        const t0 = NOON;
        journal.record({ kind: "request", requestId: REQ(1), jobId: JOB, status: "success" });
        journal.record({ kind: "job", phase: "error", jobId: OTHER_JOB, reason: "failed" });
        journal.record({
            kind: "job",
            phase: "error",
            jobId: JOB,
            stage: "request",
            reason: "failed",
            status: 500,
            requestId: REQ(2),
            providerCode: "overloaded",
        });
        journal.record({ kind: "runtime", origin: "dispose", jobId: JOB });
        journal.record({ kind: "request", requestId: REQ(3), status: "success" });
        const at = clock;
        const outcome = shares.share({ requestId: REQ(2) });
        expect(outcome).toEqual({
            ok: true,
            result: { jobId: JOB, requestId: null, shared: true, sharedAt: at, ids: [REQ(1), REQ(2)] },
        });
        const name = `${stamp(at)}-job-${JOB}.json`;
        expect(shareFiles(shared)).toEqual([name]);
        if (posix) {
            expect(statSync(path.join(shared, name)).mode & 0o777).toBe(0o640);
            expect(statSync(shared).mode & 0o777).toBe(0o750);
        }
        const text = readFileSync(path.join(shared, name), "utf8");
        expect(text.endsWith("\n")).toBe(true);
        const copy = JSON.parse(text);
        expect(Object.keys(copy)).toEqual([
            "format",
            "version",
            "sharedAt",
            "app",
            "jobId",
            "requestId",
            "failure",
            "eventsPartial",
            "events",
            "requests",
        ]);
        expect(copy).toMatchObject({
            format: SHARE_FORMAT,
            version: 1,
            sharedAt: new Date(at).toISOString(),
            app: { version: "2026.10.1" },
            jobId: JOB,
            requestId: null,
            failure: { stage: "request", reason: "failed", status: 500, requestId: REQ(2), providerCode: "overloaded" },
            eventsPartial: false,
        });
        expect(SHARE_FORMAT).toBe("metatron-request-share");
        // The job's events and its requests' events only, oldest first.
        expect(copy.events).toEqual([
            { at: clock, kind: "request", requestId: REQ(1), jobId: JOB, status: "success" },
            {
                at: clock,
                kind: "job",
                phase: "error",
                jobId: JOB,
                stage: "request",
                reason: "failed",
                status: 500,
                requestId: REQ(2),
                providerCode: "overloaded",
            },
            { at: clock, kind: "runtime", origin: "dispose", jobId: JOB },
        ]);
        expect(copy.requests.map((request: { id: string }) => request.id)).toEqual([REQ(1), REQ(2)]);
        const [first, second] = copy.requests;
        expect(first).toMatchObject({
            jobId: JOB,
            startedAt: t0,
            status: "success",
            content: true,
            exchangeCount: 1,
            storedExchanges: 1,
            truncated: false,
            truncation: {},
        });
        expect(first.exchanges).toHaveLength(1);
        expect(first.exchanges[0]).toMatchObject({ success: true, status: 200, responseType: "text/event-stream" });
        // Nothing the viewer does not get: no `bytes`, no `sharedAt`.
        expect(first).not.toHaveProperty("bytes");
        expect(first).not.toHaveProperty("sharedAt");
        // The content-off row: its summary, no error text, no prompt, no exchanges, no truncation record.
        expect(second).toMatchObject({ id: REQ(2), content: false, hasError: true, providerCode: "overloaded" });
        expect(Object.keys(second)).not.toEqual(expect.arrayContaining(["error", "prompt", "exchanges", "truncation"]));
        expect(text).not.toContain("boom");
        // The rows are marked, the state counts the copy, and `state.json` was written.
        expect(history.get(REQ(1))?.sharedAt).toBe(at);
        expect(history.get(REQ(2))?.sharedAt).toBe(at);
        expect(history.get(REQ(3))?.sharedAt).toBeNull();
        expect(journal.state().shared).toEqual({ files: 1 });
        expect(stateOf(dir).shared).toEqual({ files: 1 });
        expect(journal.listShares()).toEqual([{ jobId: JOB, requestId: null, sharedAt: at }]);
        expect(warn).not.toHaveBeenCalled();
    });

    it("shares a request without a job alone as `-request-<id>.json`, answers 404 for an unknown request, and shares nothing (no `shared/`) when the credentials cannot be read", () => {
        const { shared, history, shares } = open();
        seed(history);
        expect(shares.share({ requestId: REQ(9) })).toEqual({ ok: false, status: 404, error: "No such request" });
        expect(shares.share({ jobId: OTHER_JOB })).toEqual({ ok: false, status: 404, error: "No such request" });
        expect(existsSync(shared)).toBe(false);
        const at = clock;
        expect(shares.share({ requestId: REQ(3) })).toEqual({
            ok: true,
            result: { jobId: null, requestId: REQ(3), shared: true, sharedAt: at, ids: [REQ(3)] },
        });
        expect(shareFiles(shared)).toEqual([`${stamp(at)}-request-${REQ(3)}.json`]);
        expect(readShare(shared, `${stamp(at)}-request-${REQ(3)}.json`)).toMatchObject({
            jobId: null,
            requestId: REQ(3),
            failure: null,
            events: [],
        });
        const refusing = open({
            secrets: () => {
                throw new Error("closed");
            },
        });
        seed(refusing.history);
        expect(refusing.shares.share({ jobId: JOB })).toEqual({
            ok: false,
            status: 500,
            error: "The stored credentials could not be read, so nothing was shared",
        });
        expect(existsSync(refusing.shared)).toBe(false);
        expect(refusing.history.get(REQ(1))?.sharedAt).toBeNull();
    });

    it("redacts every string again with the credentials stored now: the value in the prompt, body, URL query, header (masked by name first), error, and response, in its JSON-escaped form too; and trims a trailing credential start from every response", () => {
        const { shared, history, shares } = open();
        seed(history);
        expect(shares.share({ jobId: JOB }).ok).toBe(true);
        const text = readFileSync(path.join(shared, shareFiles(shared)![0]), "utf8");
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(PREFIX);
        const [first] = JSON.parse(text).requests;
        expect(first.prompt).toBe(JSON.stringify([{ role: "user", content: `hi ${REDACTED}` }]));
        expect(first.exchanges[0].url).toBe(`https://api.example/v1?key=${REDACTED}&x=1`);
        expect(JSON.parse(first.exchanges[0].header)).toEqual({ Authorization: REDACTED, "x-trace": "t" });
        expect(first.exchanges[0].body).toBe(JSON.stringify({ q: REDACTED }));
        expect(first.exchanges[0].response).toBe(`ok ${REDACTED} tail `);
    });

    it("trims a trailing credential start from every field the row records as cut (a display field, an exchange's metadata, the error), on a summary-only row too", () => {
        const { shared, history, shares } = open();
        const cutAt = (bound: number) => `${"x".repeat(bound - PREFIX.length)}${SECRET}`;
        history.begin(row(REQ(1)));
        history.describe(REQ(1), { modelId: "m", profileName: cutAt(KIB) });
        history.exchange(REQ(1), {
            url: "https://api.example/v1",
            header: "{}",
            body: "{}",
            response: "ok",
            success: true,
            date: cutAt(KIB),
            responseType: "text/plain",
        });
        history.finish(REQ(1), { status: "error", error: cutAt(64 * KIB) });
        history.begin(row(REQ(2), { content: false }));
        history.describe(REQ(2), { modelId: cutAt(KIB) });
        history.finish(REQ(2), { status: "success" });
        const stored = history.get(REQ(1))!;
        expect(Object.keys(stored.truncation).sort()).toEqual(["error", "exchange.0.date", "profileName"]);
        expect(stored.profileName!.endsWith(PREFIX)).toBe(true);
        expect(history.get(REQ(2))?.truncation).toEqual({ modelId: expect.anything() });
        expect(shares.share({ jobId: JOB }).ok).toBe(true);
        const text = readFileSync(path.join(shared, shareFiles(shared)![0]), "utf8");
        expect(text).not.toContain(PREFIX);
        const [first, second] = JSON.parse(text).requests;
        expect(first.profileName).toBe("x".repeat(KIB - PREFIX.length));
        expect(first.error).toBe("x".repeat(64 * KIB - PREFIX.length));
        expect(first.exchanges[0].date).toBe("x".repeat(KIB - PREFIX.length));
        // A field not cut keeps its text (only a response is trimmed unconditionally).
        expect(first.exchanges[0].responseType).toBe("text/plain");
        expect(first.truncation).toEqual(stored.truncation);
        expect(second.modelId).toBe("x".repeat(KIB - PREFIX.length));
    });
});

describe("the share module: the protocol", () => {
    it("re-shares beside the old copy and removes the old one once the rows are marked, also for a share in the same millisecond (the stamp moves on); the list names the newest", () => {
        const { shared, history, journal, shares } = open();
        seed(history);
        const t1 = clock;
        expect(shares.share({ jobId: JOB }).ok).toBe(true);
        clock += 5000;
        const t2 = clock;
        expect(shares.share({ requestId: REQ(1) })).toMatchObject({ ok: true, result: { sharedAt: t2 } });
        expect(shareFiles(shared)).toEqual([`${stamp(t2)}-job-${JOB}.json`]);
        expect(history.get(REQ(1))?.sharedAt).toBe(t2);
        expect(journal.state().shared).toEqual({ files: 1 });
        // The same millisecond: the new copy must not replace the old one before the rows are marked.
        expect(shares.share({ jobId: JOB })).toMatchObject({ ok: true, result: { sharedAt: t2 } });
        expect(shareFiles(shared)).toEqual([`${stamp(t2 + 1)}-job-${JOB}.json`]);
        expect(journal.listShares()).toEqual([{ jobId: JOB, requestId: null, sharedAt: t2 + 1 }]);
        expect(existsSync(path.join(shared, `${stamp(t1)}-job-${JOB}.json`))).toBe(false);
    });

    it("keeps the old copy and removes the new one when the rows cannot all be marked (500), so the files and the marks agree as before", () => {
        const base = open();
        seed(base.history);
        const t1 = clock;
        expect(base.shares.share({ jobId: JOB }).ok).toBe(true);
        clock += 1000;
        // A row vanishes between the read and the mark: fewer rows marked than the copy holds.
        const history = new Proxy(base.history, {
            get: (target, key) =>
                key === "setShared"
                    ? (ids: string[], at: number | null) => target.setShared(ids.slice(1), at)
                    : (target as unknown as Record<string | symbol, unknown>)[key],
        });
        const shares = createRequestShares({ history, journal: base.journal, secrets: () => [], now: () => clock });
        expect(shares.share({ jobId: JOB })).toEqual({
            ok: false,
            status: 500,
            error: "The share could not be recorded, so its copy was removed",
        });
        expect(shareFiles(base.shared)).toEqual([`${stamp(t1)}-job-${JOB}.json`]);
        expect(base.journal.state().shared).toEqual({ files: 1 });
        // No stale mark: the partial mark is what the store did, the old time elsewhere.
        expect(base.history.get(REQ(1))?.sharedAt).toBe(t1);
        expect(base.history.get(REQ(2))?.sharedAt).toBe(clock);
    });

    it("answers 500 when an older copy could not be removed after the new one was recorded, keeping the new copy and the marks (a withdrawal removes every copy)", () => {
        const base = open();
        seed(base.history);
        const t1 = clock;
        expect(base.shares.share({ jobId: JOB }).ok).toBe(true);
        clock += 1000;
        const journal = new Proxy(base.journal, {
            get: (target, key) =>
                key === "commitShare" ? () => false : (target as unknown as Record<string | symbol, unknown>)[key],
        });
        const shares = createRequestShares({ history: base.history, journal, secrets: () => [], now: () => clock });
        expect(shares.share({ jobId: JOB })).toEqual({
            ok: false,
            status: 500,
            error: "The share was updated, but an older copy could not be removed. Withdraw the share to remove every copy.",
        });
        expect(shareFiles(base.shared)).toEqual([`${stamp(t1)}-job-${JOB}.json`, `${stamp(clock)}-job-${JOB}.json`]);
        expect(base.history.get(REQ(1))?.sharedAt).toBe(clock);
        expect(base.shares.withdraw({ jobId: JOB })).toEqual({
            ok: true,
            result: { jobId: JOB, requestId: null, shared: false, sharedAt: null, ids: [REQ(1), REQ(2)] },
        });
        expect(shareFiles(base.shared)).toEqual([]);
        expect(base.history.get(REQ(1))?.sharedAt).toBeNull();
    });

    it("withdraws by request id (its job's share) or job id: the files go first, then the marks; idempotent; a job whose rows the caps removed can still be withdrawn by its id, while its request id now names a standalone target", () => {
        const { dir, shared, history, journal, shares } = open({ limit: () => 10 });
        seed(history);
        const t1 = clock;
        expect(shares.share({ jobId: JOB }).ok).toBe(true);
        expect(shares.share({ requestId: REQ(3) }).ok).toBe(true);
        expect(shareFiles(shared)).toHaveLength(2);
        expect(shares.withdraw({ requestId: REQ(2) })).toEqual({
            ok: true,
            result: { jobId: JOB, requestId: null, shared: false, sharedAt: null, ids: [REQ(1), REQ(2)] },
        });
        expect(shareFiles(shared)).toEqual([`${stamp(t1)}-request-${REQ(3)}.json`]);
        expect(history.get(REQ(1))?.sharedAt).toBeNull();
        expect(history.get(REQ(3))?.sharedAt).toBe(t1);
        expect(stateOf(dir).shared).toEqual({ files: 1 });
        // Again: nothing to remove or clear, still fine.
        expect(shares.withdraw({ jobId: JOB })).toMatchObject({ ok: true, result: { ids: [] } });
        expect(shares.withdraw({ requestId: REQ(3) })).toMatchObject({
            ok: true,
            result: { requestId: REQ(3), ids: [REQ(3)] },
        });
        expect(shareFiles(shared)).toEqual([]);
        expect(history.get(REQ(3))?.sharedAt).toBeNull();
        expect(shares.withdraw({ requestId: REQ(9) })).toEqual({
            ok: true,
            result: { jobId: null, requestId: REQ(9), shared: false, sharedAt: null, ids: [] },
        });

        // The job's rows pruned away: the share stays (the user's explicit copy) until withdrawn by job id.
        clock += 1000;
        expect(shares.share({ jobId: JOB }).ok).toBe(true);
        for (let i = 16; i < 28; i++) {
            history.begin(row(REQ(i), { jobId: null }));
        }
        history.prune(10);
        expect(history.get(REQ(1))).toBeNull();
        expect(journal.listShares()).toEqual([{ jobId: JOB, requestId: null, sharedAt: clock }]);
        // The server's fallback for a request whose row is gone: its own (empty) share, not the job's.
        expect(shares.withdraw({ requestId: REQ(1) })).toMatchObject({
            ok: true,
            result: { jobId: null, requestId: REQ(1), ids: [] },
        });
        expect(shareFiles(shared)).toHaveLength(1);
        expect(shares.withdraw({ jobId: JOB })).toMatchObject({ ok: true, result: { jobId: JOB, ids: [] } });
        expect(shareFiles(shared)).toEqual([]);
        expect(journal.state().shared).toEqual({ files: 0 });
    });

    it("answers 503 while the store is unavailable, and 500 when it fails to read or update while open", () => {
        const { shared, history, shares } = open();
        seed(history);
        expect(shares.share({ jobId: JOB }).ok).toBe(true);
        history.close();
        expect(shares.share({ jobId: JOB })).toEqual({
            ok: false,
            status: 503,
            error: "The request history is unavailable",
        });
        expect(shares.withdraw({ requestId: REQ(1) })).toEqual({
            ok: false,
            status: 503,
            error: "The request history is unavailable",
        });
        expect(shareFiles(shared)).toHaveLength(1);
        // A job withdrawal needs no read before the files go, but the marks cannot be cleared.
        expect(shares.withdraw({ jobId: JOB })).toEqual({
            ok: false,
            status: 500,
            error: "The shared copy was removed, but the request history could not be updated",
        });
        expect(shareFiles(shared)).toEqual([]);
    });
});

describe("the journal's `shared/`", () => {
    it("counts, lists, and removes only share-named regular files; removes a temp file left by a share cut short at creation and with its target; leaves every other entry alone", () => {
        const root = tempDir();
        const dir = path.join(root, "diag");
        const shared = path.join(dir, "shared");
        mkdirSync(shared, { recursive: true });
        const temp = `.share-job-${JOB}-deadbeef.tmp`;
        const otherTemp = `.share-request-${REQ(3)}-0badf00d.tmp`;
        const strays = [
            "notes.txt",
            `${stamp(NOON)}-job-${JOB}.json.bak`,
            `${stamp(NOON)}-job-not-an-id.json`,
            ".share-job-x.tmp",
        ];
        for (const name of [temp, otherTemp, ...strays]) {
            writeFileSync(path.join(shared, name), "left behind");
        }
        mkdirSync(path.join(shared, `${stamp(NOON)}-job-${OTHER_JOB}.json`));
        symlinkSync(path.join(root, "elsewhere.json"), path.join(shared, `${stamp(NOON)}-request-${REQ(2)}.json`));
        writeFileSync(path.join(root, "elsewhere.json"), "keep");
        const journal = createDiagnosticsJournal({ dir, now: () => clock });
        cleanups.push(() => journal.close());
        expect(existsSync(path.join(shared, temp))).toBe(false);
        expect(existsSync(path.join(shared, otherTemp))).toBe(false);
        expect(journal.state().shared).toEqual({ files: 0 });
        expect(journal.listShares()).toEqual([]);

        const first = saved(journal.saveShare({ jobId: JOB, requestId: null }, ["{", '"a":1', "}\n"]));
        expect(first).toEqual({ ok: true, name: `${stamp(NOON)}-job-${JOB}.json` });
        expect(readFileSync(path.join(shared, first.name), "utf8")).toBe('{"a":1}\n');
        clock += 1;
        const second = saved(journal.saveShare({ jobId: null, requestId: REQ(3) }, ["{}\n"], clock));
        expect(second).toEqual({ ok: true, name: `${stamp(clock)}-request-${REQ(3)}.json` });
        writeFileSync(path.join(shared, temp), "cut short");
        expect(journal.state().shared).toEqual({ files: 2 });
        expect(journal.listShares()).toEqual([
            { jobId: null, requestId: REQ(3), sharedAt: clock },
            { jobId: JOB, requestId: null, sharedAt: NOON },
        ]);
        // The target's copies and temp files only.
        expect(journal.removeShares({ jobId: JOB, requestId: null })).toBe(true);
        expect(existsSync(path.join(shared, first.name))).toBe(false);
        expect(existsSync(path.join(shared, temp))).toBe(false);
        expect(existsSync(path.join(shared, second.name))).toBe(true);
        expect(journal.state().shared).toEqual({ files: 1 });
        // `discardShare` takes a share name only.
        expect(journal.discardShare("notes.txt")).toBe(false);
        expect(journal.discardShare(second.name)).toBe(true);
        expect(journal.discardShare(second.name)).toBe(true);
        writeFileSync(path.join(shared, otherTemp), "cut short");
        expect(journal.removeAllShares()).toBe(true);
        expect(readdirSync(shared).sort()).toEqual(
            [...strays, `${stamp(NOON)}-job-${OTHER_JOB}.json`, `${stamp(NOON)}-request-${REQ(2)}.json`].sort(),
        );
        expect(readFileSync(path.join(root, "elsewhere.json"), "utf8")).toBe("keep");
        expect(journal.saveShare({ jobId: "not-an-id", requestId: null }, ["{}"])).toEqual({ ok: false });
        expect(journal.removeShares({ jobId: null, requestId: "not-an-id" })).toBe(false);
        expect(journal.stats().writeFailures).toBe(0);
        expect(warn).not.toHaveBeenCalled();
    });

    it("refuses a symlinked `shared/` or a file in its place: nothing is written, listed, or removed through it, the count null, the failure counted and warned once", () => {
        const { root, shared, history, journal, shares } = open();
        seed(history);
        const target = path.join(root, "target");
        mkdirSync(target);
        symlinkSync(target, shared);
        expect(shares.share({ jobId: JOB })).toEqual({
            ok: false,
            status: 500,
            error: "The shared copy could not be written",
        });
        expect(readdirSync(target)).toEqual([]);
        expect(history.get(REQ(1))?.sharedAt).toBeNull();
        expect(shares.list()).toBeNull();
        expect(shares.removeAll()).toBe(false);
        expect(shares.withdraw({ jobId: JOB })).toEqual({
            ok: false,
            status: 500,
            error: "The shared copy could not be removed",
        });
        expect(journal.state().shared).toEqual({ files: null });
        expect(lstatSync(shared).isSymbolicLink()).toBe(true);
        expect(journal.stats().writeFailures).toBeGreaterThan(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1]).toBe("ESYMLINK");

        const asFile = open();
        seed(asFile.history);
        writeFileSync(asFile.shared, "not a directory");
        expect(asFile.shares.share({ jobId: JOB }).ok).toBe(false);
        expect(readFileSync(asFile.shared, "utf8")).toBe("not a directory");
        expect(asFile.journal.listShares()).toBeNull();
    });

    it("`saveShare` removes its temp file and counts the failure when a chunk throws, and never replaces a taken name", () => {
        const { shared, journal } = open();
        function* broken() {
            yield "{";
            throw new Error("row unreadable");
        }
        expect(journal.saveShare({ jobId: JOB, requestId: null }, broken())).toEqual({ ok: false });
        expect(readdirSync(shared)).toEqual([]);
        expect(journal.stats().writeFailures).toBe(1);
        expect(journal.state().shared).toEqual({ files: 0 });
        // Three names taken (the same millisecond and the next two): the save fails, the entries stay.
        for (let i = 0; i < 3; i++) {
            writeFileSync(path.join(shared, `${stamp(NOON + i)}-job-${JOB}.json`), `taken ${i}`);
        }
        expect(journal.saveShare({ jobId: JOB, requestId: null }, ["{}"])).toEqual({ ok: false });
        for (let i = 0; i < 3; i++) {
            expect(readFileSync(path.join(shared, `${stamp(NOON + i)}-job-${JOB}.json`), "utf8")).toBe(`taken ${i}`);
        }
        expect(journal.saveShare({ jobId: JOB, requestId: null }, ["{}"], NOON + 3)).toEqual({
            ok: true,
            name: `${stamp(NOON + 3)}-job-${JOB}.json`,
        });
    });
});

describe("the journal's `eventsFor`", () => {
    const dayFile = (at: number) => `${new Date(at).toISOString().slice(0, 10)}.jsonl`;
    const match = (event: DiagnosticEvent) => event.jobId === JOB;

    it("reads the matching events from the day files of the hour before `from` on and from the ring, each once, oldest first; a day file pruned away leaves the ring's copies", () => {
        const { events, journal } = open();
        clock = NOON - 2 * DAY;
        journal.record({ kind: "job", phase: "accepted", jobId: JOB });
        clock = NOON - 30 * 60_000;
        journal.record({ kind: "job", phase: "accepted", jobId: JOB });
        clock = NOON;
        journal.record({ kind: "job", phase: "accepted", jobId: OTHER_JOB });
        journal.record({ kind: "runtime", origin: "dispose", jobId: JOB });
        journal.record({ kind: "runtime", origin: "dispose", jobId: JOB });
        clock = NOON + DAY;
        journal.record({ kind: "job", phase: "done", jobId: JOB });
        // An event only on disk (another process wrote it), and the same event twice.
        const onDisk = JSON.stringify({ at: NOON + 1, kind: "job", phase: "error", jobId: JOB, reason: "failed" });
        writeFileSync(path.join(events, dayFile(NOON)), `${onDisk}\n${onDisk}\n`, { flag: "a" });
        expect(journal.eventsFor(match, NOON)).toEqual({
            partial: false,
            events: [
                { at: NOON - 30 * 60_000, kind: "job", phase: "accepted", jobId: JOB },
                { at: NOON, kind: "runtime", origin: "dispose", jobId: JOB },
                { at: NOON, kind: "runtime", origin: "dispose", jobId: JOB },
                { at: NOON + 1, kind: "job", phase: "error", jobId: JOB, reason: "failed" },
                { at: NOON + 1, kind: "job", phase: "error", jobId: JOB, reason: "failed" },
                { at: NOON + DAY, kind: "job", phase: "done", jobId: JOB },
            ],
        });
        // From two days back: the older file's event too.
        expect(journal.eventsFor(match, NOON - 2 * DAY).events[0]).toEqual({
            at: NOON - 2 * DAY,
            kind: "job",
            phase: "accepted",
            jobId: JOB,
        });
        // The day file gone: its ring copies stand in, the on-disk-only events are gone with it.
        rmSync(path.join(events, dayFile(NOON)));
        expect(journal.eventsFor(match, NOON).events.map((event) => event.at)).toEqual([
            NOON - 30 * 60_000,
            NOON,
            NOON,
            NOON + DAY,
        ]);
        // No `events/` at all: the ring alone, not partial.
        rmSync(events, { recursive: true });
        expect(journal.eventsFor(match, NOON)).toMatchObject({ partial: false, events: expect.any(Array) });
        expect(journal.eventsFor(match, NOON).events).toHaveLength(4);
    });

    it("is partial for a malformed line, an unterminated tail, a line over 64 KiB (skipped), a day entry that is not a regular file, or a refused `events/`; the readable events are still answered", () => {
        const { root, events, journal } = open();
        journal.record({ kind: "job", phase: "accepted", jobId: JOB });
        const good = JSON.stringify({ at: NOON + 1, kind: "job", phase: "done", jobId: JOB });
        const file = path.join(events, dayFile(NOON));
        const readable = () => journal.eventsFor(match, NOON).events.map((event) => event.phase ?? event.origin);
        const base = readFileSync(file, "utf8");
        writeFileSync(file, `${base}not json\n${good}\n`);
        expect(journal.eventsFor(match, NOON)).toMatchObject({ partial: true });
        expect(readable()).toEqual(["accepted", "done"]);
        writeFileSync(file, `${base}${good}\n${good.slice(0, 10)}`);
        expect(journal.eventsFor(match, NOON)).toMatchObject({ partial: true });
        expect(readable()).toEqual(["accepted", "done"]);
        const huge = JSON.stringify({
            at: NOON + 2,
            kind: "runtime",
            origin: "dispose",
            jobId: JOB,
            stack: ["a".repeat(70_000)],
        });
        writeFileSync(file, `${base}${huge}\n${good}\n`);
        expect(journal.eventsFor(match, NOON)).toMatchObject({ partial: true });
        expect(readable()).toEqual(["accepted", "done"]);
        // Exactly 64 KiB (without its newline) is read.
        const limit = JSON.stringify({ at: NOON + 2, kind: "runtime", origin: "dispose", jobId: JOB, stack: [""] });
        const padded = limit.replace('[""]', `["${"b".repeat(64 * KIB - limit.length)}"]`);
        expect(Buffer.byteLength(padded)).toBe(64 * KIB);
        writeFileSync(file, `${base}${padded}\n${good}\n`);
        expect(journal.eventsFor(match, NOON)).toMatchObject({ partial: false });
        expect(readable()).toEqual(["accepted", "done", "dispose"]);
        writeFileSync(file, base);
        // A symlink in place of a day file is refused, not followed; a FIFO is not opened blocking.
        const target = path.join(root, "target.jsonl");
        writeFileSync(target, `${good}\n`);
        symlinkSync(target, path.join(events, dayFile(NOON + DAY)));
        expect(journal.eventsFor(match, NOON)).toMatchObject({ partial: true });
        expect(readable()).toEqual(["accepted"]);
        rmSync(path.join(events, dayFile(NOON + DAY)));
        if (posix) {
            execFileSync("mkfifo", [path.join(events, dayFile(NOON + DAY))]);
            expect(journal.eventsFor(match, NOON)).toMatchObject({ partial: true });
            expect(readable()).toEqual(["accepted"]);
            rmSync(path.join(events, dayFile(NOON + DAY)));
        }
        expect(journal.eventsFor(match, NOON)).toMatchObject({ partial: false });
        // `events/` replaced by a symlink: refused, the ring still answers.
        rmSync(events, { recursive: true });
        symlinkSync(root, events);
        expect(journal.eventsFor(match, NOON)).toEqual({
            partial: true,
            events: [{ at: NOON, kind: "job", phase: "accepted", jobId: JOB }],
        });
        // A refused read is partial, not a counted write failure.
        expect(journal.stats().writeFailures).toBe(0);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe("the store's share reads", () => {
    it("`readShare` reads a job's rows (by its id or a request's) oldest first in one go, a request without a job alone, `missing` for none, `tooLarge` past the byte bound without reading the content, `failed` once closed", () => {
        const history = createRequestHistory({
            file: path.join(tempDir(), "h.sqlite"),
            now: () => clock,
            limit: () => 1000,
        });
        cleanups.push(() => history.close());
        seed(history);
        const bytes = history.get(REQ(1))!.bytes + history.get(REQ(2))!.bytes;
        const read = history.readShare({ requestId: REQ(2) }, bytes);
        expect(read).toMatchObject({ status: "ok", target: { jobId: JOB, requestId: null } });
        expect(read.status === "ok" && read.records.map((record) => record.id)).toEqual([REQ(1), REQ(2)]);
        expect(read.status === "ok" && read.records[0].exchanges).toHaveLength(1);
        expect(history.readShare({ jobId: JOB }, bytes - 1)).toEqual({ status: "tooLarge", bytes });
        expect(history.readShare({ requestId: REQ(3) }, 1 << 30)).toMatchObject({
            status: "ok",
            target: { jobId: null, requestId: REQ(3) },
            records: [{ id: REQ(3) }],
        });
        expect(history.readShare({ requestId: REQ(3) }, 1)).toEqual({
            status: "tooLarge",
            bytes: history.get(REQ(3))!.bytes,
        });
        expect(history.readShare({ requestId: REQ(9) }, 1 << 30)).toEqual({ status: "missing" });
        expect(history.readShare({ jobId: OTHER_JOB }, 1 << 30)).toEqual({ status: "missing" });
        expect(history.shareTargetOf(REQ(1))).toEqual({ jobId: JOB, requestId: null });
        expect(history.shareTargetOf(REQ(3))).toEqual({ jobId: null, requestId: REQ(3) });
        expect(history.shareTargetOf(REQ(9))).toEqual({ jobId: null, requestId: REQ(9) });
        history.setShared([REQ(1), REQ(2), REQ(3)], NOON);
        expect(history.clearShared({ jobId: JOB, requestId: null })).toEqual([REQ(1), REQ(2)]);
        expect(history.clearShared({ jobId: JOB, requestId: null })).toEqual([]);
        expect(history.get(REQ(3))?.sharedAt).toBe(NOON);
        expect(history.clearShared({ jobId: null, requestId: REQ(3) })).toEqual([REQ(3)]);
        expect(history.get(REQ(3))?.sharedAt).toBeNull();
        history.close();
        expect(history.readShare({ jobId: JOB }, 1 << 30)).toEqual({ status: "failed" });
        expect(history.shareTargetOf(REQ(1))).toBeNull();
        expect(history.clearShared({ jobId: JOB, requestId: null })).toBeNull();
    });
});

describe("the routes", () => {
    type Client = Awaited<ReturnType<typeof createResourceTestClient>>;
    const servers: Client[] = [];
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((s) => s.close()));
    });
    async function server() {
        const s = await createResourceTestClient();
        servers.push(s);
        return s;
    }
    const sharedDir = (s: Client) => path.join(s.savePath, "diagnostics", "shared");
    const put = (s: Client, body: RequestInit["body"], init: RequestInit = {}) =>
        s.request(REQUEST_HISTORY_SHARE_PATH, {
            method: "PUT",
            headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
            ...init,
            body,
        });
    const share = (s: Client, body: unknown) => put(s, JSON.stringify(body));
    const listShares = async (s: Client) => {
        const res = await s.request(REQUEST_HISTORY_SHARES_PATH);
        expect(res.headers.get("cache-control")).toBe("no-store");
        return { res, body: (await res.json()) as { items?: unknown[]; error?: string } };
    };

    it("shares a job and withdraws it over the routes (`no-store`), lists the folder's shares (also after the rows are pruned), and marks the listed rows", async () => {
        const s = await server();
        seed(s.context.requestHistory);
        expect((await listShares(s)).body).toEqual({ items: [] });
        const shared = await share(s, { requestId: REQ(1), shared: true });
        expect(shared.status).toBe(200);
        expect(shared.headers.get("cache-control")).toBe("no-store");
        const result = (await shared.json()) as RequestHistoryShareResult;
        expect(result).toMatchObject({ jobId: JOB, requestId: null, shared: true, ids: [REQ(1), REQ(2)] });
        expect(readdirSync(sharedDir(s))).toEqual([`${stamp(result.sharedAt!)}-job-${JOB}.json`]);
        expect((await listShares(s)).body).toEqual({
            items: [{ jobId: JOB, requestId: null, sharedAt: result.sharedAt }],
        });
        const page = (await (await s.request(REQUEST_HISTORY_PATH)).json()) as {
            items: { id: string; sharedAt: number | null }[];
        };
        expect(page.items.map((item) => [item.id, item.sharedAt])).toEqual([
            [REQ(3), null],
            [REQ(2), result.sharedAt],
            [REQ(1), result.sharedAt],
        ]);
        expect(JSON.parse(readFileSync(path.join(s.savePath, "diagnostics", "state.json"), "utf8")).shared).toEqual({
            files: 1,
        });
        // The rows pruned (the cap at its minimum): the share is still listed and withdrawn by job id.
        for (let i = 16; i < 28; i++) {
            s.context.requestHistory.begin(row(REQ(i), { jobId: null }));
        }
        s.context.requestHistory.prune(10);
        expect(s.context.requestHistory.get(REQ(1))).toBeNull();
        expect((await listShares(s)).body.items).toHaveLength(1);
        const withdrawn = await share(s, { jobId: JOB, shared: false });
        expect(withdrawn.status).toBe(200);
        expect(await withdrawn.json()).toEqual({ jobId: JOB, requestId: null, shared: false, sharedAt: null, ids: [] });
        expect(readdirSync(sharedDir(s))).toEqual([]);
        expect((await listShares(s)).body).toEqual({ items: [] });
    });

    it("redacts a named key stored on the server (through `/api/llm-secrets/`, with no credential record) from the shared copy", async () => {
        const s = await server();
        const key = "sk-orphan-named-key-0123456789";
        const current = (await (await s.get("llmSecrets", "main")).json()) as { revision: string };
        const written = await s.json(
            `/api/llm-secrets/${encodeSecretPath({ kind: "entry", field: "credentials", id: "orphan" })}`,
            { value: key, baseRevision: current.revision },
            { method: "PUT" },
        );
        expect(written.status, await written.clone().text()).toBe(200);
        const history = s.context.requestHistory;
        history.begin(row(REQ(1)));
        history.exchange(REQ(1), {
            url: "https://api.example/v1",
            header: JSON.stringify({ "x-custom": key }),
            body: `{"k":"${key}"}`,
            response: `ok ${key.slice(0, 12)}`,
            success: true,
            date: "d",
        });
        history.finish(REQ(1), { status: "success" });
        expect((await share(s, { jobId: JOB, shared: true })).status).toBe(200);
        const text = readFileSync(path.join(sharedDir(s), readdirSync(sharedDir(s))[0]), "utf8");
        expect(text).not.toContain(key);
        expect(text).not.toContain(key.slice(0, 12));
        expect(text).toContain(`{\\"k\\":\\"${REDACTED}\\"}`);
    });

    it("refuses with a 400 anything but `{ jobId | requestId, shared }` with ids of the server's shapes, with a 404 a request that is not there, and with a 413 a body over 4 KiB (declared, streamed, or actual); nothing is written", async () => {
        const s = await server();
        seed(s.context.requestHistory);
        const refused = async (body: string, status: number, error: string) => {
            const res = await put(s, body);
            expect(res.status, body).toBe(status);
            expect(res.headers.get("cache-control")).toBe("no-store");
            expect(await res.json()).toEqual({ error });
        };
        const bad = "Expected { jobId | requestId, shared }";
        for (const body of [
            "not json",
            "[]",
            "null",
            '"text"',
            "{}",
            JSON.stringify({ shared: true }),
            JSON.stringify({ requestId: REQ(1) }),
            JSON.stringify({ requestId: REQ(1), shared: "true" }),
            JSON.stringify({ requestId: REQ(1), shared: 1 }),
            JSON.stringify({ requestId: REQ(1), jobId: JOB, shared: true }),
            JSON.stringify({ requestId: REQ(1), shared: true, extra: 1 }),
            JSON.stringify({ requestId: REQ(1).toUpperCase(), shared: true }),
            JSON.stringify({ requestId: TRANSLATION, shared: true }),
            JSON.stringify({ requestId: "r1", shared: true }),
            JSON.stringify({ jobId: "job-1", shared: true }),
            JSON.stringify({ jobId: `translate-${REQ(1).toUpperCase()}`, shared: true }),
            JSON.stringify({ jobId: `${JOB}/..`, shared: true }),
            JSON.stringify({ jobId: null, shared: true }),
            JSON.stringify({ requestId: null, shared: true }),
        ]) {
            await refused(body, 400, bad);
        }
        await refused(JSON.stringify({ requestId: REQ(9), shared: true }), 404, "No such request");
        await refused(JSON.stringify({ jobId: TRANSLATION, shared: true }), 404, "No such request");
        const pad = JSON.stringify({ jobId: JOB, shared: true, pad: "x".repeat(SHARE_BODY_BYTES) });
        await refused(pad, 413, "Request body too large");
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(pad.slice(0, 100)));
                controller.enqueue(new TextEncoder().encode(pad.slice(100)));
                controller.close();
            },
        });
        const streamed = await put(s, stream, { duplex: "half" } as RequestInit);
        expect(streamed.status).toBe(413);
        const lied = await put(s, pad, { headers: { "content-length": "10" } });
        expect(lied.status).toBe(413);
        // Over in bytes, under in characters.
        const wide = await put(s, `{"jobId":"${JOB}","shared":true,"pad":"${"é".repeat(SHARE_BODY_BYTES / 2)}"}`, {
            headers: { "content-length": "10" },
        });
        expect(wide.status).toBe(413);
        expect(existsSync(sharedDir(s))).toBe(false);
        // A withdrawal of a request that is not there is a 200 (nothing to withdraw).
        const gone = await share(s, { requestId: REQ(9), shared: false });
        expect(gone.status).toBe(200);
        expect(await gone.json()).toEqual({ jobId: null, requestId: REQ(9), shared: false, sharedAt: null, ids: [] });
        expect(s.context.requestHistory.get(REQ(1))?.sharedAt).toBeNull();
    });

    it("refuses the share with a 503 once shutdown began: at admission, and again after a body read that outlasted the admission; and with a 503 while the store is unavailable", async () => {
        const s = await server();
        seed(s.context.requestHistory);
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
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ jobId: JOB, shared: true })));
            },
        });
        const pending = put(s, stream, { duplex: "half" } as RequestInit);
        await waitFor(() => pulled);
        s.context.beginShutdown();
        release();
        const res = await pending;
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBe("5");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ error: "The server is shutting down" });
        expect(existsSync(sharedDir(s))).toBe(false);
        expect(s.context.requestHistory.get(REQ(1))?.sharedAt).toBeNull();
        const admission = await share(s, { jobId: JOB, shared: true });
        expect(admission.status).toBe(503);
        expect((await s.request(REQUEST_HISTORY_SHARES_PATH)).status).toBe(503);

        const closed = await server();
        seed(closed.context.requestHistory);
        closed.context.requestHistory.close();
        const unavailable = await share(closed, { jobId: JOB, shared: true });
        expect(unavailable.status).toBe(503);
        expect(unavailable.headers.get("retry-after")).toBe("5");
        expect(await unavailable.json()).toEqual({ error: "The request history is unavailable" });
        // The shares list needs no store.
        expect((await listShares(closed)).res.status).toBe(200);
    });

    it("`DELETE /api/request-history` removes every shared copy first, then the rows; when a copy cannot be removed (a symlinked `shared/`) it answers 500 and deletes nothing; `GET` shares answers 500 then", async () => {
        const s = await server();
        seed(s.context.requestHistory);
        expect((await share(s, { jobId: JOB, shared: true })).status).toBe(200);
        expect((await share(s, { requestId: REQ(3), shared: true })).status).toBe(200);
        expect(readdirSync(sharedDir(s))).toHaveLength(2);
        const deleted = await s.request(REQUEST_HISTORY_PATH, { method: "DELETE" });
        expect(deleted.status).toBe(204);
        expect(readdirSync(sharedDir(s))).toEqual([]);
        expect(s.context.requestHistory.stats().rows).toBe(0);
        expect(s.context.diagnostics.state().shared).toEqual({ files: 0 });

        const refusing = await server();
        seed(refusing.context.requestHistory);
        const elsewhere = path.join(refusing.rootDir, "elsewhere");
        mkdirSync(elsewhere);
        symlinkSync(elsewhere, sharedDir(refusing));
        const failed = await refusing.request(REQUEST_HISTORY_PATH, { method: "DELETE" });
        expect(failed.status).toBe(500);
        expect(failed.headers.get("cache-control")).toBe("no-store");
        expect(await failed.json()).toEqual({
            error: "The shared copies could not be removed, so nothing was deleted",
        });
        expect(refusing.context.requestHistory.stats().rows).toBe(3);
        const listed = await listShares(refusing);
        expect(listed.res.status).toBe(500);
        expect(listed.body).toEqual({ error: "The shared copies could not be read" });
        expect((await share(refusing, { jobId: JOB, shared: true })).status).toBe(500);
        expect(readdirSync(elsewhere)).toEqual([]);
    });
});
