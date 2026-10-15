import {
    type DiagnosticEvent,
    type DiagnosticsState,
    isJobFailureEvent,
    projectBrowserEvent,
    projectServerEvent,
} from "./diagnostics.ts";

/**
 * The Diagnostics panel's report (`docs/plan/request-history-diagnostics.md` slice 9, decision 6):
 * the browser's events and the server's state and events as one text the user copies, downloads, or
 * saves to the diagnostics folder (`POST /api/diagnostics/report`). The browser builds it with
 * `buildDiagnosticReport`; the server keeps only a text `canonicalDiagnosticReport` accepts.
 *
 * Content-free by construction (decision 9): every value goes through a projection here, whatever the
 * caller passed. What a kept report can hold is what the projections admit: ids of the server's
 * shapes (a UUID, a translation run's `translate-<UUID>`), enumerations, counts, booleans, times,
 * route templates, catalog model ids, provider error codes (`^[A-Za-z0-9_.-]{1,64}$`), and
 * application stack frames (a file path of the app's shape, its line and column). A provider code
 * and a frame's file name are the only strings with a free shape; decision 9 permits both. The
 * check is of shape, not of provenance: a text written by hand to fit the format passes.
 *
 * The format, v1 (strict; a text that differs in any byte from what the builder makes of it is
 * refused):
 *
 * ```
 * Metatron diagnostic report v1
 * Version: <app version or unknown>
 * Browser: <Chrome | Edge | Firefox | Safari | Other>
 * OS: <Android | iOS | Windows | macOS | Linux | Other>
 * Online: <true | false>
 * Viewport: <width> x <height>
 * Exported: <ISO time>
 * Content policy: ...
 * Server: <current | unavailable>
 * Server state: <compact JSON>          (only when current)
 * Omitted events: <count>
 *
 * <ISO time> <server | browser> <kind> <compact JSON of the other fields>
 * ```
 *
 * Lines end with LF, the text with one. Events are merged by time (a stable sort; the server's first
 * at an equal time). Each source keeps its newest 300 events, and the oldest events are left out
 * while the text passes 1 MiB; `Omitted events` counts both. Times are four-digit-year ISO times.
 *
 * v1 is frozen: a later change may add a kind, a field, or an enumeration value, never remove or
 * narrow one, so a report an older tab built still passes. An incompatible change is v2. A model id
 * that left the built-in catalog (`diagnosticModel`) is the one exception: such a report is refused
 * until the tab builds it again.
 */

export const DIAGNOSTIC_REPORT_HEADER = "Metatron diagnostic report v1";

/** The report's largest size, in UTF-8 bytes: the builder's cap and the route's body limit. */
export const MAX_DIAGNOSTIC_REPORT_BYTES = 1024 * 1024;

export const DIAGNOSTIC_REPORT_POLICY =
    "Content policy: no message or prompt text, bodies, headers, credentials, URLs, free-form error messages, Lua or plugin values, or names.";

export const BROWSER_FAMILIES = ["Chrome", "Edge", "Firefox", "Safari", "Other"] as const;
export const OS_FAMILIES = ["Android", "iOS", "Windows", "macOS", "Linux", "Other"] as const;

/** A saved report's file name in `reports/`: the save's UTC time to the millisecond and 8 random hex digits. */
export const REPORT_FILE_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{8}\.txt$/;

/** What `buildDiagnosticReport` reads; every value is checked there. */
export type DiagnosticReportInput = {
    meta: {
        version: unknown;
        browser: unknown;
        os: unknown;
        online: unknown;
        viewport: { width: unknown; height: unknown };
        /** Milliseconds since the epoch. */
        exportedAt: unknown;
    };
    /** `GET /api/diagnostics`'s answer, or null when it failed. */
    server: { state: unknown; events: unknown } | null;
    browser: unknown;
    /** Events already left out (a report read back); added to the count. */
    omittedEvents?: unknown;
};

const EVENTS_PER_SOURCE = 300;
const RECENT_JOB_FAILURES = 20;
const MAX_VIEWPORT = 100_000;
/** The first time past four-digit years. */
const END_OF_TIME = Date.UTC(10_000, 0, 1);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const APP_VERSION = /^\d{1,4}(?:\.\d{1,6}){1,3}$/;
const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSLATION_RUN = /^translate-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Node's `process.platform` and `process.arch` values; any other is `other`. */
const PLATFORMS = [
    "aix",
    "android",
    "darwin",
    "freebsd",
    "haiku",
    "linux",
    "openbsd",
    "sunos",
    "win32",
    "cygwin",
    "netbsd",
];
const ARCHES = ["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64"];
const OTHER = "other";
const UNKNOWN = "unknown";

const isCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is number => isCount(value) && value < END_OF_TIME;
const countOrNull = (value: unknown): number | null => (isCount(value) ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const iso = (at: number) => new Date(at).toISOString();

/** `value` when it is a four-digit-year ISO time exactly as `toISOString` writes it, else null. */
function isoTime(value: unknown): string | null {
    if (typeof value !== "string" || !ISO_TIME.test(value)) {
        return null;
    }
    const at = Date.parse(value);
    return isTime(at) && iso(at) === value ? value : null;
}

/**
 * An event of the report: the side's projection, then the report's rules: a time in range (else no
 * event; a `lastAt` out of range is dropped), and ids of the server's shapes only (a `requestId` a
 * UUID; a `jobId` a UUID, or a translation run's id on a `request` event). The id pattern of the
 * projection admits any short word; the server issues only these.
 */
function reportEvent(origin: "server" | "browser", input: unknown): DiagnosticEvent | null {
    const event = origin === "server" ? projectServerEvent(input) : projectBrowserEvent(input);
    if (!event || !isTime(event.at)) {
        return null;
    }
    if (event.lastAt !== undefined && !isTime(event.lastAt)) {
        delete event.lastAt;
    }
    if (event.requestId !== undefined && !(typeof event.requestId === "string" && UUID.test(event.requestId))) {
        delete event.requestId;
    }
    if (event.jobId !== undefined) {
        const jobId = event.jobId;
        const ok =
            typeof jobId === "string" &&
            (UUID.test(jobId) || (event.kind === "request" && TRANSLATION_RUN.test(jobId)));
        if (!ok) {
            delete event.jobId;
        }
    }
    return event;
}

/**
 * The server's state as the report holds it: every field rebuilt in a fixed order and checked (the app
 * version by its numeric shape, Node's by `x.y.z`, the platform and architecture from Node's lists,
 * else `unknown`, `other`, or null). Null when it is not a v1 state or a required field (the two times,
 * the uptime, the journal's counts) fails its check.
 */
export function projectDiagnosticsState(input: unknown): DiagnosticsState | null {
    const state = record(input);
    if (!state || state.version !== 1) {
        return null;
    }
    const writtenAt = isoTime(state.writtenAt);
    const startedAt = isoTime(state.startedAt);
    const journal = record(state.journal);
    if (
        writtenAt === null ||
        startedAt === null ||
        !isCount(state.uptimeSec) ||
        !journal ||
        !isCount(journal.eventBytes) ||
        !isCount(journal.writeFailures)
    ) {
        return null;
    }
    const app = record(state.app);
    const settings = record(state.settings);
    const history = record(state.history);
    const shared = record(state.shared);
    const workers = record(state.workers);
    const jobs = record(state.jobs);
    const failures = Array.isArray(state.recentJobFailures) ? state.recentJobFailures : [];
    return {
        version: 1,
        writtenAt,
        app: {
            version: typeof app?.version === "string" && APP_VERSION.test(app.version) ? app.version : null,
        },
        node: typeof state.node === "string" && NODE_VERSION.test(state.node) ? state.node : UNKNOWN,
        platform: PLATFORMS.includes(state.platform as string) ? (state.platform as string) : OTHER,
        arch: ARCHES.includes(state.arch as string) ? (state.arch as string) : OTHER,
        startedAt,
        uptimeSec: state.uptimeSec,
        settings: settings && {
            requestHistoryContent:
                typeof settings.requestHistoryContent === "boolean" ? settings.requestHistoryContent : null,
            requestHistoryLimit: countOrNull(settings.requestHistoryLimit),
        },
        history: history && { rows: countOrNull(history.rows), bytes: countOrNull(history.bytes) },
        journal: { eventBytes: journal.eventBytes, writeFailures: journal.writeFailures },
        // v1 grows: only a state that has the section gets it back, so a report without it stays canonical.
        ...(Object.hasOwn(state, "shared") ? { shared: shared && { files: countOrNull(shared.files) } } : {}),
        workers: workers && {
            workers: countOrNull(workers.workers),
            busy: countOrNull(workers.busy),
            queued: countOrNull(workers.queued),
            spawned: countOrNull(workers.spawned),
            terminated: countOrNull(workers.terminated),
        },
        jobs: jobs && { live: countOrNull(jobs.live) },
        recentJobFailures: failures
            .map((event) => reportEvent("server", event))
            .filter((event): event is DiagnosticEvent => event !== null && isJobFailureEvent(event))
            .slice(-RECENT_JOB_FAILURES),
    };
}

type Entry = { origin: "server" | "browser"; rank: number; index: number; event: DiagnosticEvent };

function eventLine({ origin, event }: Entry): string {
    const { at, kind, ...fields } = event;
    return `${iso(at)} ${origin} ${kind} ${JSON.stringify(fields)}`;
}

const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).length;

/**
 * The report text of `input`. Every value is checked here (a value that fails is replaced by its
 * fallback, never by the current time, so the same input always gives the same text). A server answer
 * whose state fails `projectDiagnosticsState` counts as unavailable.
 */
export function buildDiagnosticReport(input: DiagnosticReportInput): string {
    const { meta } = input;
    const state = input.server ? projectDiagnosticsState(input.server.state) : null;
    let omitted = isCount(input.omittedEvents) ? input.omittedEvents : 0;
    const entries: Entry[] = [];
    const take = (origin: "server" | "browser", rank: number, list: unknown) => {
        const events = (Array.isArray(list) ? list : [])
            .map((event) => reportEvent(origin, event))
            .filter((event): event is DiagnosticEvent => event !== null);
        const dropped = Math.max(0, events.length - EVENTS_PER_SOURCE);
        omitted = Math.min(omitted + dropped, Number.MAX_SAFE_INTEGER);
        events.slice(dropped).forEach((event, index) => entries.push({ origin, rank, index, event }));
    };
    if (state && input.server) {
        take("server", 0, input.server.events);
    }
    take("browser", 1, input.browser);
    entries.sort((a, b) => a.event.at - b.event.at || a.rank - b.rank || a.index - b.index);

    const dimension = (value: unknown) => (isCount(value) && value <= MAX_VIEWPORT ? value : 0);
    const head = [
        DIAGNOSTIC_REPORT_HEADER,
        `Version: ${typeof meta.version === "string" && APP_VERSION.test(meta.version) ? meta.version : UNKNOWN}`,
        `Browser: ${(BROWSER_FAMILIES as readonly unknown[]).includes(meta.browser) ? meta.browser : "Other"}`,
        `OS: ${(OS_FAMILIES as readonly unknown[]).includes(meta.os) ? meta.os : "Other"}`,
        `Online: ${meta.online === true}`,
        `Viewport: ${dimension(meta.viewport?.width)} x ${dimension(meta.viewport?.height)}`,
        `Exported: ${iso(isTime(meta.exportedAt) ? meta.exportedAt : 0)}`,
        DIAGNOSTIC_REPORT_POLICY,
        `Server: ${state ? "current" : "unavailable"}`,
        ...(state ? [`Server state: ${JSON.stringify(state)}`] : []),
    ];

    // Leave the oldest events out while the text passes the cap.
    const lines = entries.map(eventLine);
    const sizes = lines.map((line) => byteLength(line) + 1);
    const headBytes = byteLength(`${head.join("\n")}\n`);
    let eventBytes = sizes.reduce((sum, size) => sum + size, 0);
    let first = 0;
    const total = () => headBytes + byteLength(`Omitted events: ${omitted}\n\n`) + eventBytes;
    while (first < lines.length && total() > MAX_DIAGNOSTIC_REPORT_BYTES) {
        eventBytes -= sizes[first];
        first++;
        omitted = Math.min(omitted + 1, Number.MAX_SAFE_INTEGER);
    }
    return `${[...head, `Omitted events: ${omitted}`, "", ...lines.slice(first)].join("\n")}\n`;
}

/** The input a report text was built from, read back line by line; null when a line is not the format's. */
function parseDiagnosticReport(text: string): DiagnosticReportInput | null {
    if (!text.endsWith("\n")) {
        return null;
    }
    const lines = text.slice(0, -1).split("\n");
    let next = 0;
    const exact = (line: string) => lines[next++] === line;
    const labeled = (label: string): string | null => {
        const line = lines[next++];
        return typeof line === "string" && line.startsWith(label) ? line.slice(label.length) : null;
    };
    if (!exact(DIAGNOSTIC_REPORT_HEADER)) {
        return null;
    }
    const version = labeled("Version: ");
    const browser = labeled("Browser: ");
    const os = labeled("OS: ");
    const online = labeled("Online: ");
    const viewport = /^(\d{1,6}) x (\d{1,6})$/.exec(labeled("Viewport: ") ?? "");
    const exported = labeled("Exported: ");
    if (!exact(DIAGNOSTIC_REPORT_POLICY)) {
        return null;
    }
    const status = labeled("Server: ");
    let server: { state: unknown; events: unknown[] } | null = null;
    if (status === "current") {
        const state = labeled("Server state: ");
        if (state === null) {
            return null;
        }
        server = { state: JSON.parse(state), events: [] };
    } else if (status !== "unavailable") {
        return null;
    }
    const omitted = labeled("Omitted events: ");
    if (
        version === null ||
        browser === null ||
        os === null ||
        (online !== "true" && online !== "false") ||
        !viewport ||
        exported === null ||
        omitted === null ||
        !/^\d{1,16}$/.test(omitted) ||
        !exact("")
    ) {
        return null;
    }
    const browserEvents: unknown[] = [];
    for (; next < lines.length; next++) {
        const line = /^(\S+) (server|browser) ([A-Za-z]+) (\{.*\})$/.exec(lines[next]);
        if (!line) {
            return null;
        }
        const fields = record(JSON.parse(line[4]));
        const target = line[2] === "server" ? server?.events : browserEvents;
        if (!fields || !target) {
            return null;
        }
        target.push({ ...fields, at: Date.parse(line[1]), kind: line[3] });
    }
    return {
        meta: {
            version,
            browser,
            os,
            online: online === "true",
            viewport: { width: Number(viewport[1]), height: Number(viewport[2]) },
            exportedAt: Date.parse(exported),
        },
        server,
        browser: browserEvents,
        omittedEvents: Number(omitted),
    };
}

/**
 * `text` when it is a report exactly as `buildDiagnosticReport` makes it (the server's check before it
 * saves one), else null. The text is read back into the builder's input and built again; only an
 * identical result passes, so nothing the projections drop survives, in any field or line. Never
 * throws.
 */
export function canonicalDiagnosticReport(text: unknown): string | null {
    try {
        if (typeof text !== "string" || text.length > MAX_DIAGNOSTIC_REPORT_BYTES) {
            return null;
        }
        if (byteLength(text) > MAX_DIAGNOSTIC_REPORT_BYTES) {
            return null;
        }
        const input = parseDiagnosticReport(text);
        return input && buildDiagnosticReport(input) === text ? text : null;
    } catch {
        return null;
    }
}
