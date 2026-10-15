// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type DiagnosticsState, projectBrowserEvent, projectServerEvent } from "../diagnostics.ts";
import {
    buildDiagnosticReport,
    canonicalDiagnosticReport,
    DIAGNOSTIC_REPORT_HEADER,
    DIAGNOSTIC_REPORT_POLICY,
    type DiagnosticReportInput,
    MAX_DIAGNOSTIC_REPORT_BYTES,
    projectDiagnosticsState,
    REPORT_FILE_PATTERN,
} from "../diagnosticsReport.ts";
import { BASE_LLM_MODELS } from "../llm/models.ts";

// Request history slice 9 (`docs/plan/request-history-diagnostics.md`, decisions 6 and 9): the
// Diagnostics panel's report (`shared/diagnosticsReport.ts`). The tests are written against the
// format's contract, not the builder's code: the exact v1 text of a known input; every metadata
// value's fallback; the state projection's required fields, nullable sections, and lists; the
// report's rules over the event projections (each side's kinds, four-digit-year times, ids of the
// server's shapes); the merge order; the per-source cap and the byte cap with `Omitted events`;
// and the server's check (`canonicalDiagnosticReport`): the builder's own text passes, and every
// variant that is not that text, byte for byte, is refused, so a kept report holds nothing a
// projection drops (no free text, no URL, no message, no path outside the application).

const JOB = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
const REQUEST = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_JOB = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const TRANSLATION_RUN = `translate-${JOB}`;
const CATALOG_MODEL = BASE_LLM_MODELS[0].id;
/** 2026-10-13T10:15:00.000Z. */
const EXPORTED = Date.UTC(2026, 9, 13, 10, 15);
const AT = EXPORTED - 2_000;
const ISO = (at: number) => new Date(at).toISOString();
/** The first millisecond of year 10000: not a time of the report. */
const END_OF_TIME = Date.UTC(10_000, 0, 1);
const PRIVATE = "Private Character said hello";

const state = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: 1,
    writtenAt: ISO(AT - 500),
    app: { version: "2026.8.250" },
    node: "24.1.0",
    platform: "linux",
    arch: "x64",
    startedAt: ISO(AT - 60_000),
    uptimeSec: 60,
    settings: { requestHistoryContent: true, requestHistoryLimit: 1000 },
    history: { rows: 3, bytes: 4096 },
    journal: { eventBytes: 128, writeFailures: 0 },
    workers: { workers: 2, busy: 1, queued: 0, spawned: 2, terminated: 0 },
    jobs: { live: 1 },
    recentJobFailures: [],
    ...over,
});

const meta = (over: Partial<DiagnosticReportInput["meta"]> = {}): DiagnosticReportInput["meta"] => ({
    version: "2026.8.250",
    browser: "Chrome",
    os: "Windows",
    online: true,
    viewport: { width: 1280, height: 720 },
    exportedAt: EXPORTED,
    ...over,
});

const serverJob = { at: AT, kind: "job", phase: "error", jobId: JOB, stage: "request", reason: "failed", status: 429 };
const browserLink = { at: AT + 100, kind: "jobLink", phase: "detach", jobId: JOB, code: 1006 };

const input = (over: Partial<DiagnosticReportInput> = {}): DiagnosticReportInput => ({
    meta: meta(),
    server: { state: state(), events: [serverJob] },
    browser: [browserLink],
    ...over,
});

/** The lines of a report's text (without the final LF). */
const linesOf = (text: string) => text.slice(0, -1).split("\n");
const eventLines = (text: string) => linesOf(text).slice(linesOf(text).indexOf("") + 1);
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("buildDiagnosticReport: the v1 text", () => {
    it("is the header, the metadata lines, the policy, the server's state as one compact JSON line, the omitted count, a blank line, then one line per event, LF-separated with one final LF", () => {
        const text = buildDiagnosticReport(input());
        expect(text).toBe(
            [
                "Metatron diagnostic report v1",
                "Version: 2026.8.250",
                "Browser: Chrome",
                "OS: Windows",
                "Online: true",
                "Viewport: 1280 x 720",
                "Exported: 2026-10-13T10:15:00.000Z",
                DIAGNOSTIC_REPORT_POLICY,
                "Server: current",
                `Server state: ${JSON.stringify(projectDiagnosticsState(state()))}`,
                "Omitted events: 0",
                "",
                `${ISO(AT)} server job {"phase":"error","jobId":"${JOB}","stage":"request","reason":"failed","status":429}`,
                `${ISO(AT + 100)} browser jobLink {"phase":"detach","jobId":"${JOB}","code":1006}`,
                "",
            ].join("\n"),
        );
        expect(DIAGNOSTIC_REPORT_HEADER).toBe("Metatron diagnostic report v1");
        expect(DIAGNOSTIC_REPORT_POLICY).toMatch(/^Content policy: /);
        expect(text).not.toContain("\r");
        expect(text.endsWith("\n\n")).toBe(false);
    });

    it("without the server (no answer, or a state that is not a v1 state) says `Server: unavailable` with no state line and no server events", () => {
        const text = buildDiagnosticReport(input({ server: null }));
        expect(linesOf(text).slice(8, 10)).toEqual(["Server: unavailable", "Omitted events: 0"]);
        expect(eventLines(text)).toEqual([
            `${ISO(AT + 100)} browser jobLink {"phase":"detach","jobId":"${JOB}","code":1006}`,
        ]);
        const unversioned = buildDiagnosticReport(
            input({ server: { state: state({ version: 2 }), events: [serverJob] } }),
        );
        expect(unversioned).toBe(text);
        const noState = buildDiagnosticReport(input({ server: { state: "state", events: [serverJob] } }));
        expect(noState).toBe(text);
    });

    it("checks every metadata value and falls back deterministically (never to the current time): the version by its numeric shape, the families by their lists, online as a boolean, the viewport as counts up to 100000, the export time as a four-digit-year time", () => {
        const text = buildDiagnosticReport(
            input({
                meta: meta({
                    version: `2026.8.250 ${PRIVATE}`,
                    browser: "Chromium 120",
                    os: PRIVATE,
                    online: "true",
                    viewport: { width: 100_001, height: -1 },
                    exportedAt: END_OF_TIME,
                }),
            }),
        );
        expect(linesOf(text).slice(1, 7)).toEqual([
            "Version: unknown",
            "Browser: Other",
            "OS: Other",
            "Online: false",
            "Viewport: 0 x 0",
            "Exported: 1970-01-01T00:00:00.000Z",
        ]);
        expect(text).not.toContain(PRIVATE);
        const edge = buildDiagnosticReport(
            input({
                meta: meta({
                    version: "1.2",
                    browser: "Safari",
                    os: "iOS",
                    online: false,
                    viewport: { width: 100_000, height: 1.5 },
                    exportedAt: END_OF_TIME - 1,
                }),
            }),
        );
        expect(linesOf(edge).slice(1, 7)).toEqual([
            "Version: 1.2",
            "Browser: Safari",
            "OS: iOS",
            "Online: false",
            "Viewport: 100000 x 0",
            "Exported: 9999-12-31T23:59:59.999Z",
        ]);
        for (const version of ["v1.2.3", "1", "1.2.3.4.5", "12345.1", "1.1234567", "1.2-beta", ""]) {
            expect(linesOf(buildDiagnosticReport(input({ meta: meta({ version }) })))[1]).toBe("Version: unknown");
        }
        for (const exportedAt of [-1, 1.5, "2026-10-13T10:15:00.000Z", NaN, undefined]) {
            expect(linesOf(buildDiagnosticReport(input({ meta: meta({ exportedAt }) })))[6]).toBe(
                "Exported: 1970-01-01T00:00:00.000Z",
            );
        }
        expect(buildDiagnosticReport(input())).toBe(buildDiagnosticReport(input()));
    });

    it("takes each side's events through its own projection: a server kind on the browser's side and a browser kind on the server's are dropped, as are the window's runtime origins on the server and the server's on the browser", () => {
        const text = buildDiagnosticReport(
            input({
                server: {
                    state: state(),
                    events: [
                        serverJob,
                        { at: AT + 1, kind: "jobLink", phase: "attach", jobId: JOB },
                        { at: AT + 2, kind: "runtime", origin: "error", name: "TypeError" },
                        { at: AT + 3, kind: "runtime", origin: "generation.listener", jobId: JOB, name: "TypeError" },
                        { at: AT + 4, kind: "lifecycle", phase: "boot" },
                    ],
                },
                browser: [
                    browserLink,
                    { at: AT + 101, kind: "job", phase: "done", jobId: JOB },
                    { at: AT + 102, kind: "lifecycle", phase: "boot" },
                    { at: AT + 103, kind: "runtime", origin: "generation.listener", name: "TypeError" },
                    { at: AT + 104, kind: "runtime", origin: "error", jobId: JOB, name: "TypeError" },
                    { at: AT + 105, kind: "page", phase: "visible" },
                ],
            }),
        );
        expect(eventLines(text)).toEqual([
            `${ISO(AT)} server job {"phase":"error","jobId":"${JOB}","stage":"request","reason":"failed","status":429}`,
            `${ISO(AT + 3)} server runtime {"origin":"generation.listener","jobId":"${JOB}","name":"TypeError"}`,
            `${ISO(AT + 4)} server lifecycle {"phase":"boot"}`,
            `${ISO(AT + 100)} browser jobLink {"phase":"detach","jobId":"${JOB}","code":1006}`,
            // The browser's runtime event has no job id (a server-only field).
            `${ISO(AT + 104)} browser runtime {"origin":"error","name":"TypeError"}`,
            `${ISO(AT + 105)} browser page {"phase":"visible"}`,
        ]);
    });

    it("keeps no free text from any event: a message, a URL, a name, a non-catalog model, a frame outside the application, an unknown field, and an id that is not of the server's shapes are all left out", () => {
        const text = buildDiagnosticReport(
            input({
                server: {
                    state: state(),
                    events: [
                        {
                            at: AT,
                            kind: "job",
                            phase: "error",
                            jobId: "short-word",
                            requestId: PRIVATE,
                            message: PRIVATE,
                            stage: "request",
                            reason: PRIVATE,
                            providerCode: "rate_limit_exceeded",
                        },
                        {
                            at: AT + 1,
                            kind: "request",
                            requestId: "not-a-uuid",
                            jobId: TRANSLATION_RUN,
                            source: "send",
                            status: "error",
                            provider: "OpenAI",
                            model: `gpt-${PRIVATE}`,
                            providerCode: `rate limit: ${PRIVATE}`,
                            url: "https://api.example.com/v1?key=secret",
                            error: PRIVATE,
                        },
                        {
                            at: AT + 2,
                            kind: "http",
                            method: "GET",
                            route: "/api/resources/characters/private-id",
                            status: 500,
                            body: PRIVATE,
                        },
                        {
                            at: AT + 3,
                            kind: "runtime",
                            origin: "dispose",
                            name: `Error: ${PRIVATE}`,
                            stack: ["server/src/app.ts:1:2", `/home/user/${PRIVATE}.ts:1:1`],
                            message: PRIVATE,
                        },
                    ],
                },
                browser: [
                    { at: AT + 100, kind: "jobLink", phase: "attach", jobId: PRIVATE },
                    {
                        at: AT + 101,
                        kind: "runtime",
                        origin: "error",
                        name: "TypeError",
                        stack: [`src/${PRIVATE}.ts:1:1`],
                    },
                    {
                        at: AT + 102,
                        kind: "http",
                        method: "POST",
                        route: "/api/diagnostics/report",
                        status: 400,
                        url: "/x?y",
                    },
                ],
            }),
        );
        expect(text).not.toContain(PRIVATE);
        expect(text).not.toContain("short-word");
        expect(text).not.toContain("not-a-uuid");
        expect(text).not.toContain("example.com");
        expect(text).not.toContain("private-id");
        expect(eventLines(text)).toEqual([
            `${ISO(AT)} server job {"phase":"error","stage":"request","providerCode":"rate_limit_exceeded"}`,
            // `OpenAI` is not an `LLMFormat` name; a provider code with a space is not a code.
            `${ISO(AT + 1)} server request {"jobId":"${TRANSLATION_RUN}","source":"send","status":"error"}`,
            `${ISO(AT + 2)} server http {"method":"GET","status":500}`,
            // A free-text error name is dropped (the source writes `?` for one); so is the frame outside the app.
            `${ISO(AT + 3)} server runtime {"origin":"dispose"}`,
            `${ISO(AT + 100)} browser jobLink {"phase":"attach"}`,
            `${ISO(AT + 101)} browser runtime {"origin":"error","name":"TypeError"}`,
            `${ISO(AT + 102)} browser http {"method":"POST","route":"/api/diagnostics/report","status":400}`,
        ]);
    });

    it("admits a job id only as a UUID, or a translation run's `translate-<UUID>` on a `request` event; a request id only as a UUID", () => {
        const line = (event: Record<string, unknown>) =>
            eventLines(buildDiagnosticReport(input({ server: { state: state(), events: [event] }, browser: [] })))[0];
        expect(line({ at: AT, kind: "request", requestId: REQUEST, jobId: JOB })).toBe(
            `${ISO(AT)} server request {"requestId":"${REQUEST}","jobId":"${JOB}"}`,
        );
        expect(line({ at: AT, kind: "request", requestId: TRANSLATION_RUN, jobId: TRANSLATION_RUN })).toBe(
            `${ISO(AT)} server request {"jobId":"${TRANSLATION_RUN}"}`,
        );
        expect(line({ at: AT, kind: "job", phase: "done", jobId: TRANSLATION_RUN, requestId: TRANSLATION_RUN })).toBe(
            `${ISO(AT)} server job {"phase":"done"}`,
        );
        expect(line({ at: AT, kind: "runtime", origin: "dispose", jobId: TRANSLATION_RUN })).toBe(
            `${ISO(AT)} server runtime {"origin":"dispose"}`,
        );
        expect(line({ at: AT, kind: "job", phase: "done", jobId: JOB.toUpperCase() })).toBe(
            `${ISO(AT)} server job {"phase":"done"}`,
        );
        expect(line({ at: AT, kind: "job", phase: "done", jobId: `${JOB}-` })).toBe(
            `${ISO(AT)} server job {"phase":"done"}`,
        );
    });

    it("keeps only events whose time is a four-digit-year time, and drops a `lastAt` outside that range on its own", () => {
        const text = buildDiagnosticReport(
            input({
                server: null,
                browser: [
                    { at: END_OF_TIME, kind: "page", phase: "visible" },
                    { at: END_OF_TIME - 1, kind: "page", phase: "visible", repeat: 2, lastAt: END_OF_TIME },
                    { at: AT, kind: "page", phase: "hidden", repeat: 3, lastAt: AT + 5 },
                    { at: -1, kind: "page", phase: "visible" },
                    { at: AT + 0.5, kind: "page", phase: "visible" },
                ],
            }),
        );
        expect(eventLines(text)).toEqual([
            `${ISO(AT)} browser page {"phase":"hidden","repeat":3,"lastAt":${AT + 5}}`,
            `9999-12-31T23:59:59.999Z browser page {"phase":"visible","repeat":2}`,
        ]);
    });

    it("merges the sides by time with a stable order: the server's event first at an equal time, each side in its own order", () => {
        const text = buildDiagnosticReport(
            input({
                server: {
                    state: state(),
                    events: [
                        { at: AT + 10, kind: "lifecycle", phase: "boot" },
                        { at: AT, kind: "lifecycle", phase: "shutdown" },
                        { at: AT, kind: "lifecycle", phase: "restore" },
                    ],
                },
                browser: [
                    { at: AT, kind: "page", phase: "visible" },
                    { at: AT - 1, kind: "page", phase: "boot" },
                    { at: AT + 10, kind: "page", phase: "hidden" },
                ],
            }),
        );
        expect(eventLines(text).map((line) => line.split(" ").slice(1, 4).join(" "))).toEqual([
            `browser page {"phase":"boot"}`,
            `server lifecycle {"phase":"shutdown"}`,
            `server lifecycle {"phase":"restore"}`,
            `browser page {"phase":"visible"}`,
            `server lifecycle {"phase":"boot"}`,
            `browser page {"phase":"hidden"}`,
        ]);
    });

    it("keeps each source's newest 300 events and counts the rest, with the caller's own omitted count added, saturating at the largest safe integer", () => {
        const browser = Array.from({ length: 302 }, (_, i) => ({ at: AT + i, kind: "page", phase: "visible" }));
        const server = Array.from({ length: 301 }, (_, i) => ({ at: AT + i, kind: "lifecycle", phase: "boot" }));
        const text = buildDiagnosticReport(input({ server: { state: state(), events: server }, browser }));
        const events = eventLines(text);
        expect(events).toHaveLength(600);
        expect(events.slice(0, 3)).toEqual([
            `${ISO(AT + 1)} server lifecycle {"phase":"boot"}`,
            `${ISO(AT + 2)} server lifecycle {"phase":"boot"}`,
            `${ISO(AT + 2)} browser page {"phase":"visible"}`,
        ]);
        expect(events.at(-1)).toBe(`${ISO(AT + 301)} browser page {"phase":"visible"}`);
        expect(linesOf(text)[10]).toBe("Omitted events: 3");
        expect(linesOf(buildDiagnosticReport(input({ omittedEvents: 7 })))[10]).toBe("Omitted events: 7");
        for (const omittedEvents of [-1, 1.5, "7", null]) {
            expect(linesOf(buildDiagnosticReport(input({ omittedEvents })))[10]).toBe("Omitted events: 0");
        }
        const saturated = buildDiagnosticReport(
            input({ omittedEvents: Number.MAX_SAFE_INTEGER - 1, server: { state: state(), events: server } }),
        );
        expect(linesOf(saturated)[10]).toBe(`Omitted events: ${Number.MAX_SAFE_INTEGER}`);
        expect(canonicalDiagnosticReport(saturated)).toBe(saturated);
    });

    it("leaves the oldest events out while the text passes 1 MiB, counting them, and the result still passes the server's check", () => {
        // A runtime line with 8 long frames (a `shared/` file is a frame of either side) is about 1.9 KB; 600 of them pass the cap.
        const stack = Array.from({ length: 8 }, (_, i) => `shared/${"a".repeat(195)}${i}.ts:1234567:1234567`);
        const browser = Array.from({ length: 300 }, (_, i) => ({
            at: AT + i,
            kind: "runtime",
            origin: "error",
            stack,
        }));
        const server = Array.from({ length: 300 }, (_, i) => ({
            at: AT + i,
            kind: "runtime",
            origin: "dispose",
            stack,
        }));
        const text = buildDiagnosticReport(input({ server: { state: state(), events: server }, browser }));
        expect(bytes(text)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_REPORT_BYTES);
        const events = eventLines(text);
        expect(events.length).toBeLessThan(600);
        expect(events.length).toBeGreaterThan(500);
        const omitted = 600 - events.length;
        expect(linesOf(text)[10]).toBe(`Omitted events: ${omitted}`);
        // The newest are kept: the first line left is the one right after the omitted ones.
        expect(events[0].startsWith(`${ISO(AT + Math.ceil(omitted / 2))} `)).toBe(true);
        expect(events.at(-1)!.startsWith(`${ISO(AT + 299)} browser runtime `)).toBe(true);
        // Adding one more line would pass the cap.
        const longest = Math.max(...events.map((line) => bytes(line) + 1));
        expect(bytes(text) + longest).toBeGreaterThan(MAX_DIAGNOSTIC_REPORT_BYTES);
        expect(canonicalDiagnosticReport(text)).toBe(text);
    });
});

describe("projectDiagnosticsState", () => {
    it("rebuilds every field in a fixed order with its check: the app version numeric or null, Node `x.y.z` or `unknown`, the platform and architecture from Node's lists or `other`, the sections nullable, their leaves counts or null", () => {
        const projected = projectDiagnosticsState(
            state({
                app: { version: `2026.8.250 ${PRIVATE}`, name: PRIVATE },
                node: "v24.1.0",
                platform: PRIVATE,
                arch: "amd64",
                settings: { requestHistoryContent: "yes", requestHistoryLimit: -1, extra: PRIVATE },
                history: null,
                workers: { workers: 1.5, busy: null, queued: 0, spawned: "2", terminated: 1 },
                jobs: { live: 2, names: [PRIVATE] },
                extra: PRIVATE,
            }),
        );
        expect(projected).toEqual({
            version: 1,
            writtenAt: ISO(AT - 500),
            app: { version: null },
            node: "unknown",
            platform: "other",
            arch: "other",
            startedAt: ISO(AT - 60_000),
            uptimeSec: 60,
            settings: { requestHistoryContent: null, requestHistoryLimit: null },
            history: null,
            journal: { eventBytes: 128, writeFailures: 0 },
            workers: { workers: null, busy: null, queued: 0, spawned: null, terminated: 1 },
            jobs: { live: 2 },
            recentJobFailures: [],
        });
        expect(JSON.stringify(projected)).not.toContain(PRIVATE);
        expect(Object.keys(projectDiagnosticsState(state())!)).toEqual([
            "version",
            "writtenAt",
            "app",
            "node",
            "platform",
            "arch",
            "startedAt",
            "uptimeSec",
            "settings",
            "history",
            "journal",
            "workers",
            "jobs",
            "recentJobFailures",
        ]);
        expect(projectDiagnosticsState(state())).toEqual(state());
        expect(projectDiagnosticsState(state({ platform: "win32", arch: "arm64", node: "22.0.0" }))).toMatchObject({
            platform: "win32",
            arch: "arm64",
            node: "22.0.0",
        });
        expect(projectDiagnosticsState(state({ settings: null, workers: null, jobs: null }))).toMatchObject({
            settings: null,
            workers: null,
            jobs: null,
        });
    });

    it("keeps the optional `shared` section (slice 10) only when the input owns the key, after `journal`, as `{ files }` checked or null, so a report an older tab built without it stays canonical", () => {
        // A state from before slice 10 (or an older tab's projection): no key, not even an explicit absence.
        const old = projectDiagnosticsState(state())!;
        expect(Object.hasOwn(old, "shared")).toBe(false);
        expect(Object.keys(projectDiagnosticsState(state({ shared: { files: 2 } }))!)).toEqual([
            "version",
            "writtenAt",
            "app",
            "node",
            "platform",
            "arch",
            "startedAt",
            "uptimeSec",
            "settings",
            "history",
            "journal",
            "shared",
            "workers",
            "jobs",
            "recentJobFailures",
        ]);
        expect(projectDiagnosticsState(state({ shared: { files: 2 } }))).toMatchObject({ shared: { files: 2 } });
        expect(projectDiagnosticsState(state({ shared: { files: 0, names: [PRIVATE] } }))).toMatchObject({
            shared: { files: 0 },
        });
        expect(
            JSON.stringify(projectDiagnosticsState(state({ shared: { files: 0, names: [PRIVATE] } }))),
        ).not.toContain(PRIVATE);
        expect(projectDiagnosticsState(state({ shared: { files: null } }))).toMatchObject({ shared: { files: null } });
        expect(projectDiagnosticsState(state({ shared: { files: -1 } }))).toMatchObject({ shared: { files: null } });
        expect(projectDiagnosticsState(state({ shared: { files: "1" } }))).toMatchObject({ shared: { files: null } });
        expect(projectDiagnosticsState(state({ shared: {} }))).toMatchObject({ shared: { files: null } });
        expect(projectDiagnosticsState(state({ shared: null }))).toMatchObject({ shared: null });
        expect(projectDiagnosticsState(state({ shared: "x" }))).toMatchObject({ shared: null });
        expect(projectDiagnosticsState(state({ shared: undefined }))).toMatchObject({ shared: null });
        // Both an old report and a new one are their own canonical text.
        for (const over of [{}, { shared: { files: 1 } }, { shared: null }]) {
            const text = buildDiagnosticReport(input({ server: { state: state(over), events: [serverJob] } }));
            expect(canonicalDiagnosticReport(text)).toBe(text);
        }
        const withShared = buildDiagnosticReport(
            input({ server: { state: state({ shared: { files: 1 } }), events: [] } }),
        );
        expect(withShared).toContain('"journal":{"eventBytes":128,"writeFailures":0},"shared":{"files":1},"workers"');
        const without = buildDiagnosticReport(input({ server: { state: state(), events: [] } }));
        expect(without).not.toContain('"shared"');
        expect(canonicalDiagnosticReport(withShared.replace('"shared":{"files":1},', ""))).toBe(
            withShared.replace('"shared":{"files":1},', ""),
        );
    });

    it("is null for anything but a v1 state object, or one whose times, uptime, or journal counts fail", () => {
        expect(projectDiagnosticsState(null)).toBeNull();
        expect(projectDiagnosticsState([])).toBeNull();
        expect(projectDiagnosticsState("state")).toBeNull();
        expect(projectDiagnosticsState(state({ version: "1" }))).toBeNull();
        expect(projectDiagnosticsState(state({ version: 2 }))).toBeNull();
        expect(projectDiagnosticsState(state({ writtenAt: AT }))).toBeNull();
        expect(projectDiagnosticsState(state({ writtenAt: "2026-10-13T10:14:58Z" }))).toBeNull();
        expect(projectDiagnosticsState(state({ writtenAt: "2026-10-13T10:14:58.123+00:00" }))).toBeNull();
        expect(projectDiagnosticsState(state({ writtenAt: "2026-02-30T00:00:00.000Z" }))).toBeNull();
        expect(projectDiagnosticsState(state({ startedAt: "+010000-01-01T00:00:00.000Z" }))).toBeNull();
        expect(projectDiagnosticsState(state({ uptimeSec: -1 }))).toBeNull();
        expect(projectDiagnosticsState(state({ uptimeSec: 1.5 }))).toBeNull();
        expect(projectDiagnosticsState(state({ journal: null }))).toBeNull();
        expect(projectDiagnosticsState(state({ journal: { eventBytes: 1 } }))).toBeNull();
        expect(projectDiagnosticsState(state({ journal: { eventBytes: "1", writeFailures: 0 } }))).toBeNull();
    });

    it("keeps of `recentJobFailures` only job failures (an owner's abort is not one) under the report's rules, the last 20", () => {
        const failures = [
            { at: AT, kind: "job", phase: "error", jobId: JOB, reason: "failed", message: PRIVATE },
            { at: AT + 1, kind: "job", phase: "error", jobId: JOB, reason: "aborted" },
            { at: AT + 2, kind: "job", phase: "done", jobId: JOB },
            { at: AT + 3, kind: "runtime", origin: "dispose" },
            { at: END_OF_TIME, kind: "job", phase: "error", jobId: JOB, reason: "failed" },
            { at: AT + 5, kind: "job", phase: "error", jobId: "short", reason: "timeout", requestId: REQUEST },
            PRIVATE,
        ];
        expect(projectDiagnosticsState(state({ recentJobFailures: failures }))!.recentJobFailures).toEqual([
            { at: AT, kind: "job", phase: "error", jobId: JOB, reason: "failed" },
            { at: AT + 5, kind: "job", phase: "error", reason: "timeout", requestId: REQUEST },
        ]);
        const many = Array.from({ length: 25 }, (_, i) => ({
            at: AT + i,
            kind: "job",
            phase: "error",
            reason: "failed",
        }));
        const kept = projectDiagnosticsState(state({ recentJobFailures: many }))!.recentJobFailures;
        expect(kept).toHaveLength(20);
        expect(kept[0].at).toBe(AT + 5);
        expect(projectDiagnosticsState(state({ recentJobFailures: PRIVATE }))!.recentJobFailures).toEqual([]);
    });
});

describe("canonicalDiagnosticReport", () => {
    const report = buildDiagnosticReport(
        input({
            server: {
                state: state({ recentJobFailures: [serverJob] }),
                events: [
                    serverJob,
                    {
                        at: AT + 1,
                        kind: "request",
                        requestId: REQUEST,
                        jobId: JOB,
                        source: "send",
                        status: "success",
                        provider: "OpenAI",
                        model: CATALOG_MODEL,
                        httpStatus: 200,
                        durationMs: 1200,
                        requestBytes: 2048,
                        responseBytes: 512,
                    },
                    {
                        at: AT + 2,
                        kind: "runtime",
                        origin: "dispose",
                        name: "TypeError",
                        stack: ["server/src/app.ts:1:2"],
                    },
                ],
            },
            browser: [
                browserLink,
                { at: AT + 101, kind: "runtime", origin: "error", name: "TypeError", stack: ["src/App.svelte:10:5"] },
                { at: AT + 102, kind: "page", phase: "hidden", repeat: 2, lastAt: AT + 150 },
            ],
        }),
    );
    const browserOnly = buildDiagnosticReport(input({ server: null }));
    /** `report` with one line replaced (or removed with `null`). */
    const edited = (match: (line: string) => boolean, replace: string | null) => {
        const lines = linesOf(report);
        const index = lines.findIndex(match);
        expect(index).toBeGreaterThanOrEqual(0);
        if (replace === null) {
            lines.splice(index, 1);
        } else {
            lines[index] = replace;
        }
        return `${lines.join("\n")}\n`;
    };
    const stateLine = (line: string) => line.startsWith("Server state: ");
    const jobLine = (line: string) => line.includes(" server job ");
    const pageLine = (line: string) => line.includes(" browser page ");

    it("accepts the builder's own text, byte for byte, with and without the server, and with no events", () => {
        expect(canonicalDiagnosticReport(report)).toBe(report);
        expect(canonicalDiagnosticReport(browserOnly)).toBe(browserOnly);
        const empty = buildDiagnosticReport(input({ server: { state: state(), events: [] }, browser: [] }));
        expect(empty.endsWith("Omitted events: 0\n\n")).toBe(true);
        expect(canonicalDiagnosticReport(empty)).toBe(empty);
        const fallbacks = buildDiagnosticReport(
            input({ meta: meta({ version: PRIVATE, browser: PRIVATE, os: PRIVATE, online: 1, exportedAt: -1 }) }),
        );
        expect(canonicalDiagnosticReport(fallbacks)).toBe(fallbacks);
    });

    it("refuses anything that is not a string, a text over 1 MiB in characters or in UTF-8 bytes, and a text that is not a report", () => {
        expect(canonicalDiagnosticReport(undefined)).toBeNull();
        expect(canonicalDiagnosticReport(null)).toBeNull();
        expect(canonicalDiagnosticReport(new TextEncoder().encode(report))).toBeNull();
        expect(canonicalDiagnosticReport("")).toBeNull();
        expect(canonicalDiagnosticReport("\n")).toBeNull();
        expect(canonicalDiagnosticReport(PRIVATE)).toBeNull();
        expect(canonicalDiagnosticReport(`${DIAGNOSTIC_REPORT_HEADER}\n`)).toBeNull();
        expect(canonicalDiagnosticReport("x".repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1))).toBeNull();
        // Under the limit in characters, over it in bytes.
        expect(canonicalDiagnosticReport("é".repeat(MAX_DIAGNOSTIC_REPORT_BYTES / 2 + 1))).toBeNull();
    });

    it("refuses a text whose framing differs: CRLF, no final newline, a second final newline, a blank line missing or doubled, text before or after the report, a line out of order", () => {
        expect(canonicalDiagnosticReport(report.replace(/\n/g, "\r\n"))).toBeNull();
        expect(canonicalDiagnosticReport(report.slice(0, -1))).toBeNull();
        expect(canonicalDiagnosticReport(`${report}\n`)).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Omitted events: 0\n\n", "Omitted events: 0\n"))).toBeNull();
        expect(
            canonicalDiagnosticReport(report.replace("Omitted events: 0\n\n", "Omitted events: 0\n\n\n")),
        ).toBeNull();
        expect(canonicalDiagnosticReport(`\n${report}`)).toBeNull();
        expect(canonicalDiagnosticReport(`${report}${PRIVATE}\n`)).toBeNull();
        expect(canonicalDiagnosticReport(`${report}\n${PRIVATE}`)).toBeNull();
        expect(canonicalDiagnosticReport(` ${report.slice(1)}`)).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Online: true\n", "Online: true \n"))).toBeNull();
        const lines = linesOf(report);
        [lines[1], lines[2]] = [lines[2], lines[1]];
        expect(canonicalDiagnosticReport(`${lines.join("\n")}\n`)).toBeNull();
    });

    it("refuses a header, label, or policy line that is not the exact one, and a `Server:` status outside the two", () => {
        expect(canonicalDiagnosticReport(report.replace("report v1", "report v2"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("report v1", "report v1 "))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Version: ", "version: "))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Content policy: ", "Content policy:  "))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("URLs", `URLs, ${PRIVATE}`))).toBeNull();
        expect(canonicalDiagnosticReport(edited((line) => line.startsWith("Content policy:"), null))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Server: current", "Server: Current"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Server: current", "Server: stale"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Online: true", "Online: yes"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Viewport: 1280 x 720", "Viewport: 1280x720"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Viewport: 1280 x 720", "Viewport: 01280 x 720"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Viewport: 1280 x 720", "Viewport: 100001 x 720"))).toBeNull();
    });

    it("refuses free text or a wrong shape in any metadata line: it is not what the builder makes of it", () => {
        expect(canonicalDiagnosticReport(report.replace("Version: 2026.8.250", `Version: ${PRIVATE}`))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Version: 2026.8.250", "Version: 2026.8.250-beta"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Version: 2026.8.250", "Version: "))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Browser: Chrome", `Browser: ${PRIVATE}`))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Browser: Chrome", "Browser: chrome"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("OS: Windows", "OS: Windows 11"))).toBeNull();
        expect(
            canonicalDiagnosticReport(report.replace("Exported: 2026-10-13T10:15:00.000Z", `Exported: ${PRIVATE}`)),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(
                report.replace("Exported: 2026-10-13T10:15:00.000Z", "Exported: 2026-10-13T10:15:00Z"),
            ),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(
                report.replace("Exported: 2026-10-13T10:15:00.000Z", "Exported: 2026-10-13T10:15:00.000+00:00"),
            ),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(
                report.replace("Exported: 2026-10-13T10:15:00.000Z", "Exported: +010000-01-01T00:00:00.000Z"),
            ),
        ).toBeNull();
        // The fallback spelled by hand is the builder's own text, so it passes; any other time of the same instant does not.
        const epoch = report.replace("Exported: 2026-10-13T10:15:00.000Z", "Exported: 1970-01-01T00:00:00.000Z");
        expect(canonicalDiagnosticReport(epoch)).toBe(epoch);
        expect(canonicalDiagnosticReport(report.replace("Omitted events: 0", "Omitted events: 00"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Omitted events: 0", "Omitted events: -1"))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("Omitted events: 0", "Omitted events: 1e3"))).toBeNull();
        expect(
            canonicalDiagnosticReport(report.replace("Omitted events: 0", "Omitted events: 9007199254740992")),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(report.replace("Omitted events: 0", "Omitted events: 99999999999999999")),
        ).toBeNull();
        const omitted = report.replace("Omitted events: 0", "Omitted events: 9007199254740991");
        expect(canonicalDiagnosticReport(omitted)).toBe(omitted);
    });

    it("refuses a state line that is not the projection's compact JSON: an added field, a reordered key, a free-text value, another number spelling, a state the projection refuses, a state line without `current` or `current` without one", () => {
        const stateJson = linesOf(report).find(stateLine)!.slice("Server state: ".length);
        const withState = (json: string) => edited(stateLine, `Server state: ${json}`);
        expect(
            canonicalDiagnosticReport(
                withState(stateJson.replace('"node":"24.1.0"', `"node":"24.1.0","host":"${PRIVATE}"`)),
            ),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(withState(stateJson.replace('"node":"24.1.0"', `"node":"${PRIVATE}"`))),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(withState(stateJson.replace('"node":"24.1.0"', '"node":"24.1.0" '))),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(
                withState(stateJson.replace('"platform":"linux","arch":"x64"', '"arch":"x64","platform":"linux"')),
            ),
        ).toBeNull();
        expect(canonicalDiagnosticReport(withState(stateJson.replace('"version":1,', '"version":1.0,')))).toBeNull();
        expect(canonicalDiagnosticReport(withState(stateJson.replace('"uptimeSec":60', '"uptimeSec":6e1')))).toBeNull();
        expect(
            canonicalDiagnosticReport(withState(stateJson.replace('"writeFailures":0', '"writeFailures":-0'))),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(withState(stateJson.replace('"platform":"linux"', '"platform":"\\u006cinux"'))),
        ).toBeNull();
        expect(canonicalDiagnosticReport(withState(stateJson.replace('"version":1,', '"version":2,')))).toBeNull();
        expect(canonicalDiagnosticReport(withState(stateJson.replace('"uptimeSec":60', '"uptimeSec":-1')))).toBeNull();
        expect(canonicalDiagnosticReport(withState(`${stateJson} `))).toBeNull();
        expect(canonicalDiagnosticReport(withState("{"))).toBeNull();
        expect(canonicalDiagnosticReport(withState("null"))).toBeNull();
        expect(canonicalDiagnosticReport(withState("[]"))).toBeNull();
        expect(canonicalDiagnosticReport(edited(stateLine, null))).toBeNull();
        const unavailableWithState = report.replace("Server: current", "Server: unavailable");
        expect(canonicalDiagnosticReport(unavailableWithState)).toBeNull();
        expect(
            canonicalDiagnosticReport(`${browserOnly.replace("Server: unavailable", "Server: current")}`),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(
                browserOnly.replace("Server: unavailable\n", `Server: unavailable\nServer state: ${stateJson}\n`),
            ),
        ).toBeNull();
        // A failure inside the state follows the report's rules too.
        expect(
            canonicalDiagnosticReport(
                withState(stateJson.replace(`"jobId":"${JOB}"`, `"jobId":"${JOB}","message":"${PRIVATE}"`)),
            ),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(withState(stateJson.replace(`"jobId":"${JOB}"`, '"jobId":"short"'))),
        ).toBeNull();
    });

    it("refuses an event line that is not an event's canonical line: another time spelling, an origin outside the two, a kind of the other side, free text, an added or reordered field, an id of another shape, another JSON spelling", () => {
        const job = linesOf(report).find(jobLine)!;
        const withJob = (line: string) => edited(jobLine, line);
        expect(canonicalDiagnosticReport(withJob(job.replace(".000Z", "Z")))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace(".000Z", ".000+00:00")))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace(ISO(AT), String(AT))))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace(ISO(AT), "+010000-01-01T00:00:00.000Z")))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace(" server job ", " Server job ")))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace(" server job ", " browser job ")))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace(" server job ", " server script ")))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace(" server job ", " server  job ")))).toBeNull();
        expect(
            canonicalDiagnosticReport(
                withJob(job.replace('"phase":"error"', `"phase":"error","message":"${PRIVATE}"`)),
            ),
        ).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace('"phase":"error"', `"phase":"${PRIVATE}"`)))).toBeNull();
        // A field left out is what the projection makes of a missing one, so that line is canonical.
        const phaseless = withJob(job.replace('"phase":"error",', ""));
        expect(canonicalDiagnosticReport(phaseless)).toBe(phaseless);
        expect(
            canonicalDiagnosticReport(
                withJob(
                    job
                        .replace('"phase":"error","jobId"', '"jobId"')
                        .replace('"status":429}', '"status":429,"phase":"error"}'),
                ),
            ),
        ).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace(`"jobId":"${JOB}"`, '"jobId":"short-word"')))).toBeNull();
        expect(
            canonicalDiagnosticReport(withJob(job.replace(`"jobId":"${JOB}"`, `"jobId":"${TRANSLATION_RUN}"`))),
        ).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace('"status":429', '"status":429.0')))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace('"status":429', '"status": 429')))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace('"status":429', '"status":"429"')))).toBeNull();
        expect(
            canonicalDiagnosticReport(withJob(job.replace('"stage":"request"', '"stage":"\\u0072equest"'))),
        ).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace("}", `,"at":${AT}}`)))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace("}", ',"kind":"job"}')))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(`${job} `))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(`${job}\r`))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(job.replace("{", "[").replace(/}$/, "]")))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(`${ISO(AT)} server job`))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(`${ISO(AT)} server job {}{}`))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(PRIVATE))).toBeNull();
        expect(canonicalDiagnosticReport(withJob(""))).toBeNull();
        // The job's `translate-` id is only a `request` event's; a browser frame outside the app, a URL as a route.
        const page = linesOf(report).find(pageLine)!;
        expect(
            canonicalDiagnosticReport(
                edited(pageLine, page.replace(`"lastAt":${AT + 150}`, `"lastAt":${END_OF_TIME}`)),
            ),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(edited(pageLine, page.replace('"repeat":2', '"repeat":2,"url":"/x?y"'))),
        ).toBeNull();
        expect(canonicalDiagnosticReport(edited((line) => line.includes("src/App.svelte"), ""))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("src/App.svelte:10:5", `/home/${PRIVATE}:10:5`))).toBeNull();
        expect(canonicalDiagnosticReport(report.replace("src/App.svelte:10:5", "server/src/app.ts:10:5"))).toBe(
            report.replace("src/App.svelte:10:5", "server/src/app.ts:10:5"),
        );
        expect(
            canonicalDiagnosticReport(report.replace(`"model":"${CATALOG_MODEL}"`, `"model":"${PRIVATE}"`)),
        ).toBeNull();
    });

    it("refuses events out of the merge order, a browser line before a server line at the same time, and more than 300 of one side (the builder would have left some out)", () => {
        const lines = linesOf(report);
        const events = lines.slice(lines.indexOf("") + 1);
        const swapped = [...events];
        [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
        expect(
            canonicalDiagnosticReport(`${[...lines.slice(0, lines.indexOf("") + 1), ...swapped].join("\n")}\n`),
        ).toBeNull();
        const head = lines.slice(0, lines.indexOf("") + 1);
        const serverAt = `${ISO(AT)} server lifecycle {"phase":"boot"}`;
        const browserAt = `${ISO(AT)} browser page {"phase":"boot"}`;
        expect(canonicalDiagnosticReport(`${[...head, serverAt, browserAt].join("\n")}\n`)).toBe(
            `${[...head, serverAt, browserAt].join("\n")}\n`,
        );
        expect(canonicalDiagnosticReport(`${[...head, browserAt, serverAt].join("\n")}\n`)).toBeNull();
        const many = Array.from({ length: 301 }, (_, i) => `${ISO(AT + i)} browser page {"phase":"visible"}`);
        expect(canonicalDiagnosticReport(`${[...head, ...many].join("\n")}\n`)).toBeNull();
        expect(canonicalDiagnosticReport(`${[...head, ...many.slice(1)].join("\n")}\n`)).toBe(
            `${[...head, ...many.slice(1)].join("\n")}\n`,
        );
    });

    it("never throws: a hostile JSON (a prototype key, a deep nesting, a broken escape) is refused", () => {
        const job = linesOf(report).find(jobLine)!;
        const withJob = (line: string) => edited(jobLine, line);
        expect(
            canonicalDiagnosticReport(
                withJob(job.replace('"phase":"error"', '"__proto__":{"phase":"error"},"phase":"error"')),
            ),
        ).toBeNull();
        expect(
            canonicalDiagnosticReport(withJob(`${ISO(AT)} server job ${'{"a":'.repeat(5000)}1${"}".repeat(5000)}`)),
        ).toBeNull();
        expect(canonicalDiagnosticReport(withJob(`${ISO(AT)} server job {"phase":"\\x"}`))).toBeNull();
        expect(canonicalDiagnosticReport(edited(stateLine, 'Server state: {"__proto__":{"version":1}}'))).toBeNull();
    });
});

describe("the side projections and the file name pattern", () => {
    it("`projectServerEvent` keeps the server's kinds and runtime origins only; `projectBrowserEvent` the browser's, without a runtime job id", () => {
        expect(projectServerEvent({ at: AT, kind: "job", phase: "done", jobId: JOB })).toEqual({
            at: AT,
            kind: "job",
            phase: "done",
            jobId: JOB,
        });
        expect(projectServerEvent({ at: AT, kind: "runtime", origin: "dispose", jobId: JOB })).toEqual({
            at: AT,
            kind: "runtime",
            origin: "dispose",
            jobId: JOB,
        });
        expect(projectServerEvent({ at: AT, kind: "runtime", origin: "error" })).toBeNull();
        expect(projectServerEvent({ at: AT, kind: "runtime", origin: "unhandledrejection" })).toBeNull();
        // An origin is a field like any other: without one the event is either side's.
        expect(projectServerEvent({ at: AT, kind: "runtime" })).toEqual({ at: AT, kind: "runtime" });
        for (const kind of ["jobLink", "feed", "sync", "serviceWorker", "page"]) {
            expect(projectServerEvent({ at: AT, kind })).toBeNull();
        }
        expect(projectServerEvent({ at: AT, kind: "http", method: "GET", status: 500 })).toEqual({
            at: AT,
            kind: "http",
            method: "GET",
            status: 500,
        });
        expect(projectServerEvent(null)).toBeNull();
        expect(
            projectBrowserEvent({ at: AT, kind: "runtime", origin: "error", jobId: JOB, name: "TypeError" }),
        ).toEqual({ at: AT, kind: "runtime", origin: "error", name: "TypeError" });
        expect(projectBrowserEvent({ at: AT, kind: "runtime", origin: "dispose" })).toBeNull();
        for (const kind of ["job", "request", "lifecycle"]) {
            expect(projectBrowserEvent({ at: AT, kind, phase: "boot" })).toBeNull();
        }
        expect(projectBrowserEvent({ at: AT, kind: "jobLink", phase: "attach", jobId: OTHER_JOB })).toEqual({
            at: AT,
            kind: "jobLink",
            phase: "attach",
            jobId: OTHER_JOB,
        });
    });

    it("`REPORT_FILE_PATTERN` is the save's UTC stamp to the millisecond and 8 hex digits, `.txt`", () => {
        expect(REPORT_FILE_PATTERN.test("20261013T101500123Z-0123abcd.txt")).toBe(true);
        expect(REPORT_FILE_PATTERN.test("20261013T101500123Z-0123ABCD.txt")).toBe(false);
        expect(REPORT_FILE_PATTERN.test("20261013T101500123Z-0123abc.txt")).toBe(false);
        expect(REPORT_FILE_PATTERN.test("20261013T101500123-0123abcd.txt")).toBe(false);
        expect(REPORT_FILE_PATTERN.test("2026-10-13T10:15:00.123Z-0123abcd.txt")).toBe(false);
        expect(REPORT_FILE_PATTERN.test("20261013T101500123Z-0123abcd.txt\n")).toBe(false);
        expect(REPORT_FILE_PATTERN.test(".20261013T101500123Z-0123abcd.txt")).toBe(false);
        expect(REPORT_FILE_PATTERN.test("20261013T101500123Z-0123abcd.tmp")).toBe(false);
        expect(REPORT_FILE_PATTERN.test("../20261013T101500123Z-0123abcd.txt")).toBe(false);
    });
});
