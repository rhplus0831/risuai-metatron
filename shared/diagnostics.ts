import { GENERATION_ERROR_REASONS, GENERATION_ERROR_STAGES, GENERATION_ID_PATTERN, GENERATION_KINDS } from "./jobs.ts";
import { LLMFormat } from "./llm.ts";
import { BASE_LLM_MODELS } from "./llm/models.ts";
import { REQUEST_SOURCES } from "./llm/request.ts";
import { isProviderCode, PROVIDER_CODE_PATTERN } from "./requestHistory.ts";

export { isProviderCode, PROVIDER_CODE_PATTERN };

/**
 * The diagnostic events (`docs/plan/request-history-diagnostics.md` "Diagnostics folder", slices 7
 * and 8): a closed set of kinds, each with an exact-key projection. Content-free by construction
 * (decision 9): every field has its own check, a key not in its kind's list is dropped, and a value
 * that fails its check is dropped (the rest of the event is kept). Strings are ids, enumerations, a
 * provider error code, a route template from `ROUTE_TEMPLATES`, a catalog model id, or an
 * application stack frame.
 *
 * The server writes `http`, `job`, `request`, `runtime`, and `lifecycle`; the browser's collector
 * (`src/ts/diagnostics/collector.ts`) writes `http`, `runtime`, and the browser kinds `jobLink`,
 * `feed`, `sync`, `serviceWorker`, and `page`.
 */
export const DIAGNOSTIC_EVENT_KINDS = [
    "http",
    "job",
    "request",
    "runtime",
    "lifecycle",
    "jobLink",
    "feed",
    "sync",
    "serviceWorker",
    "page",
] as const;

/** `GET`: the server's ring and state (`server/src/routes/diagnostics.ts`). */
export const DIAGNOSTICS_PATH = "/api/diagnostics";

/** `POST`: a report the Diagnostics panel saves to the folder's `reports/` (`shared/diagnosticsReport.ts`). */
export const DIAGNOSTICS_REPORT_PATH = "/api/diagnostics/report";

export type DiagnosticEventKind = (typeof DIAGNOSTIC_EVENT_KINDS)[number];

export type DiagnosticValue = string | number | boolean | string[];

/** A projected event: when (ms since the epoch), its kind, and its checked fields. */
export type DiagnosticEvent = { at: number; kind: DiagnosticEventKind; [field: string]: DiagnosticValue };

/** What a producer hands over; the projection decides what is kept. */
export type DiagnosticEventInput = { kind: DiagnosticEventKind; [field: string]: unknown };

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export const JOB_EVENT_PHASES = ["accepted", "done", "error"] as const;

export const REQUEST_EVENT_STATUSES = ["success", "error", "aborted"] as const;

/**
 * Where a `runtime` event comes from: the process's uncaught exception (`uncaughtExceptionMonitor`'s
 * origins), the HTTP server's `error`, a failed dispose, the server's caught faults
 * (`server/src/diagnostics/log.ts`), and the browser window's `error` and `unhandledrejection`.
 */
export const RUNTIME_ORIGINS = [
    "uncaughtException",
    "unhandledRejection",
    "serverError",
    "dispose",
    "generation.socketSend",
    "generation.channelClose",
    "generation.endDelivery",
    "generation.runnerSettle",
    "generation.listener",
    "generation.release",
    "error",
    "unhandledrejection",
] as const;

export type RuntimeOrigin = (typeof RUNTIME_ORIGINS)[number];

/** A tab's follow of a server job: its socket opened, closed before the end, or never opened; a retry; the end of the follow without the job's end; a saved job followed again after a reload. */
export const JOB_LINK_PHASES = ["attach", "detach", "attachFailed", "reattach", "lost", "resume"] as const;

/** The live-update socket: a `hello` of the loaded epoch, a close of a socket that was open, a connection that never opened. */
export const FEED_PHASES = ["connected", "disconnected", "connectFailed"] as const;

/** The save loop: a 409 it recovers from, a reload of the page (after a restore, or a service worker that did not initialize). */
export const SYNC_PHASES = ["conflict", "reload"] as const;

export const SYNC_REASONS = ["restore", "serviceWorker"] as const;

export const SERVICE_WORKER_PHASES = [
    "registered",
    "registerFailed",
    "initFailed",
    "unsupported",
    "controllerChange",
] as const;

export const PAGE_PHASES = ["boot", "visible", "hidden", "online", "offline"] as const;

/** Why a same-origin fetch has no status: it rejected (no answer), or its signal timed out. */
export const HTTP_FAILURES = ["rejected", "timeout"] as const;

export const LIFECYCLE_PHASES = [
    "boot",
    "shutdown",
    "maintenanceStart",
    "maintenanceEnd",
    "restore",
    "import",
    "moduleImport",
    "charxImport",
    "realmImport",
] as const;

/** The model of a request whose id is not in the built-in catalog (a custom or user-entered model). */
export const CUSTOM_MODEL = "custom";

/** The error classes an event may name; any other name (a free text) is `?`. */
const ERROR_NAMES = new Set([
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "AbortError",
    "TimeoutError",
    "GenerationRunnerError",
    "GenerationJobEndedError",
    "JobWriteConflictError",
    "SendError",
    "ChatBindingError",
    "LuaJobFatalError",
    "JobRequestError",
    "FatalRequestError",
    "CallbackFailedError",
    "ResourceBatchConflictError",
    "TriggerEffectLimitError",
    "CbsLimitError",
    // The browser's DOMException names.
    "NetworkError",
    "QuotaExceededError",
    "NotAllowedError",
    "SecurityError",
    "InvalidStateError",
    "DataCloneError",
    "NotFoundError",
    "NotSupportedError",
    "ResourceConflictError",
    "ResourceEpochMismatchError",
]);

export const UNKNOWN_ERROR_NAME = "?";

/**
 * `error`'s class name when it is a known one, else `?` (a thrown primitive included). An object
 * with a `name` counts (an error of another realm, a DOMException); a `name` getter that throws is `?`.
 */
export function errorName(error: unknown): string {
    try {
        const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null;
        return typeof name === "string" && ERROR_NAMES.has(name) ? name : UNKNOWN_ERROR_NAME;
    } catch {
        return UNKNOWN_ERROR_NAME;
    }
}

/** A stack frame's location: `at fn (path:line:col)` or `at path:line:col`. */
const FRAME = /^\s+at (?:.*\()?(?:file:\/\/)?([^()\s]+):(\d{1,7}):(\d{1,7})\)?$/;

/** The frames a `stack` field keeps. */
export const MAX_STACK_FRAMES = 8;

/**
 * The application frames of `error`'s stack (`path:line:col`), at most `max`. `appPath` maps a
 * frame's file to its application-relative path, or null for any other file (a dependency, Node's
 * internals). Only the frames are read: the stack's header (the error's name and message, which
 * may span lines) must be exactly what the error says now, else nothing is read, so a message never
 * reaches the result. A frame without a file location (`<anonymous>`, `native`) is passed over; a
 * line that is not a frame ends the stack.
 *
 * This keeps message text out of an honest stack; it does not authenticate a forged `error.stack`,
 * which is why the projection checks every frame again (`isStackFrame`). V8's format (the server,
 * Chromium); the browser's collector also reads Gecko and WebKit stacks.
 */
export function sanitizeStack(
    error: unknown,
    appPath: (file: string) => string | null,
    max: number = MAX_STACK_FRAMES,
): string[] {
    if (!(error instanceof Error)) {
        return [];
    }
    const stack = typeof error.stack === "string" ? error.stack : "";
    const header = error.message ? `${error.name}: ${error.message}` : error.name;
    if (!stack.startsWith(`${header}\n`)) {
        return [];
    }
    const frames: string[] = [];
    for (const line of stack.slice(header.length + 1).split("\n")) {
        if (frames.length >= max || !/^\s+at /.test(line)) {
            break;
        }
        const frame = FRAME.exec(line);
        if (!frame) {
            continue;
        }
        const file = appPath(frame[1]);
        const located = file === null ? null : `${file}:${frame[2]}:${frame[3]}`;
        if (located !== null && isStackFrame(located)) {
            frames.push(located);
        }
    }
    return frames;
}

/**
 * An application frame: a source file under `server/src/` or `shared/` (no dots in its directories
 * or base name, so no `..`), its line, and its column.
 */
export const APP_FRAME = /^(?:server\/src|shared)\/[A-Za-z0-9_/-]{1,200}\.[cm]?[jt]s:\d{1,7}:\d{1,7}$/;

/**
 * A browser frame: a source file the dev server serves under `src/` or `shared/` (a `.svelte`,
 * `.svelte.ts`, or script file; no dots in its directories), or a chunk of the build under `assets/`
 * with Vite's 8-character hash (dots in the chunk's name, never `..`), its line, and its column.
 */
export const CLIENT_FRAME =
    /^(?:(?:src|shared)\/[A-Za-z0-9_/-]{1,200}(?:\.svelte(?:\.[jt]s)?|\.[cm]?[jt]s)|assets\/(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js):\d{1,7}:\d{1,7}$/;

/** Whether `frame` is an application frame of the server or the browser. */
export function isStackFrame(frame: unknown): frame is string {
    return typeof frame === "string" && (APP_FRAME.test(frame) || CLIENT_FRAME.test(frame));
}

/**
 * Every route an `http` event may name: the server's registered templates (`app.routes`), the
 * service worker's `/sw/` routes the browser fetches, and `?` for any other. Literal templates come
 * before parameter ones, so `apiRouteTemplate` matches `/api/resources/revisions` before
 * `/api/resources/:kind`.
 */
export const ROUTE_TEMPLATES = [
    "/api/generations",
    "/api/generations/:id",
    "/api/generations/*",
    "/api/transform",
    "/api/transform/continue",
    "/api/translate/message",
    "/api/push/key",
    "/api/push/subscription",
    "/api/llm/request",
    "/api/llm/request/:id/answer",
    "/api/request-history",
    "/api/request-history/share",
    "/api/request-history/shares",
    "/api/request-history/:id",
    "/api/diagnostics",
    "/api/diagnostics/report",
    "/api/test_auth",
    "/api/login",
    "/api/crypto",
    "/api/set_password",
    "/api/read",
    "/api/remove",
    "/api/list",
    "/api/write",
    "/api/assets/write",
    "/api/assets/read",
    "/api/resources",
    "/api/resources/read",
    "/api/resources/batch",
    "/api/resources/revisions",
    "/api/resources/:kind",
    "/api/resources/:kind/:id",
    "/api/resources/*",
    "/api/llm-secrets/*",
    "/api/backups",
    "/api/backups/export",
    "/api/backups/import",
    "/api/backups/:id/restore",
    "/api/import/module",
    "/api/import/charx",
    "/api/import/realm",
    "/proxy",
    "/proxy2",
    "/hub-proxy/*",
    "/sw/init",
    "/sw/check/*",
    "/sw/img/*",
    "/sw/register/*",
    "/sw/share/*",
    "/",
    "/index.html",
    "/*",
    "?",
] as const;

const ROUTE_TEMPLATE_SET: ReadonlySet<string> = new Set(ROUTE_TEMPLATES);

/** Whether a same-origin path is one the browser's collector records: the API, the proxies, the service worker's routes. */
export function isApiPath(pathname: string): boolean {
    return /^\/(?:api|hub-proxy|sw)\//.test(pathname) || pathname === "/proxy" || pathname === "/proxy2";
}

/**
 * The template of a same-origin path (`ROUTE_TEMPLATES`): `:x` matches one segment, a trailing `*`
 * the rest; `?` when none does. Only a literal template is returned, never a segment of the path.
 */
export function apiRouteTemplate(pathname: string): string {
    const segments = pathname.split("/");
    for (const template of ROUTE_TEMPLATES) {
        const parts = template.split("/");
        if (template === "?" || template === "/*") {
            continue;
        }
        const wildcard = parts[parts.length - 1] === "*";
        const fixed = wildcard ? parts.slice(0, -1) : parts;
        if (wildcard ? segments.length <= fixed.length : segments.length !== fixed.length) {
            continue;
        }
        if (fixed.every((part, i) => (part.startsWith(":") ? segments[i] !== "" : part === segments[i]))) {
            return template;
        }
    }
    return "?";
}

type Check = (value: unknown) => boolean;

const oneOf =
    (values: readonly unknown[]): Check =>
    (value) =>
        values.includes(value);
const id: Check = (value) => typeof value === "string" && GENERATION_ID_PATTERN.test(value);
/** The server's job ids (`randomUUID`): the browser's `jobLink` takes no other text. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid: Check = (value) => typeof value === "string" && UUID.test(value);
const bool: Check = (value) => typeof value === "boolean";
/** A WebSocket close code. */
const closeCode: Check = (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 4999;
const count: Check = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const httpStatus: Check = (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
const stack: Check = (value) => Array.isArray(value) && value.length <= MAX_STACK_FRAMES && value.every(isStackFrame);

const PROVIDER_NAMES = Object.keys(LLMFormat);
let catalog: Set<string> | null = null;
const catalogModels = () => (catalog ??= new Set(BASE_LLM_MODELS.map((model) => model.id)));

/** A request's model as an event names it: its id when the built-in catalog has it, else `custom`. */
export function diagnosticModel(modelId: string | null | undefined): string | null {
    if (typeof modelId !== "string" || modelId === "") {
        return null;
    }
    return catalogModels().has(modelId) ? modelId : CUSTOM_MODEL;
}

const SCHEMAS: Record<DiagnosticEventKind, Record<string, Check>> = {
    http: {
        method: oneOf(HTTP_METHODS),
        route: (value) => typeof value === "string" && ROUTE_TEMPLATE_SET.has(value),
        status: httpStatus,
        failure: oneOf(HTTP_FAILURES),
        durationMs: count,
    },
    job: {
        phase: oneOf(JOB_EVENT_PHASES),
        jobId: id,
        jobKind: oneOf(GENERATION_KINDS),
        stage: oneOf(GENERATION_ERROR_STAGES),
        reason: oneOf(GENERATION_ERROR_REASONS),
        status: httpStatus,
        requestId: id,
        providerCode: isProviderCode,
        durationMs: count,
    },
    request: {
        requestId: id,
        jobId: id,
        source: oneOf(REQUEST_SOURCES),
        status: oneOf(REQUEST_EVENT_STATUSES),
        provider: oneOf(PROVIDER_NAMES),
        model: (value) => value === CUSTOM_MODEL || (typeof value === "string" && catalogModels().has(value)),
        httpStatus,
        providerCode: isProviderCode,
        durationMs: count,
        requestBytes: count,
        responseBytes: count,
    },
    runtime: {
        origin: oneOf(RUNTIME_ORIGINS),
        jobId: id,
        name: (value) => value === UNKNOWN_ERROR_NAME || (typeof value === "string" && ERROR_NAMES.has(value)),
        stack,
    },
    lifecycle: {
        phase: oneOf(LIFECYCLE_PHASES),
        replaced: bool,
    },
    jobLink: {
        phase: oneOf(JOB_LINK_PHASES),
        jobId: uuid,
        attempt: count,
        code: closeCode,
        terminal: bool,
    },
    feed: {
        phase: oneOf(FEED_PHASES),
        attempt: count,
        code: closeCode,
    },
    sync: {
        phase: oneOf(SYNC_PHASES),
        reason: oneOf(SYNC_REASONS),
        records: count,
        chats: count,
        orders: count,
        generating: count,
    },
    serviceWorker: {
        phase: oneOf(SERVICE_WORKER_PHASES),
    },
    page: {
        phase: oneOf(PAGE_PHASES),
    },
};

/** Every kind's: how many identical events this one stands for and when the last was (the browser's collector folds repeats). */
const COMMON: Record<string, Check> = { repeat: count, lastAt: count };

/**
 * The content-free projection of an event (`input` with its `at`): its kind's fields that pass
 * their checks, or null for an unknown kind or an `at` that is not a time. The result is a new
 * object; a `stack` is copied.
 */
export function projectDiagnosticEvent(input: unknown): DiagnosticEvent | null {
    if (typeof input !== "object" || input === null) {
        return null;
    }
    const source = input as Record<string, unknown>;
    const kind = source.kind;
    if (!(DIAGNOSTIC_EVENT_KINDS as readonly unknown[]).includes(kind) || !count(source.at)) {
        return null;
    }
    const event: DiagnosticEvent = { at: source.at as number, kind: kind as DiagnosticEventKind };
    for (const [field, check] of [...Object.entries(SCHEMAS[kind as DiagnosticEventKind]), ...Object.entries(COMMON)]) {
        const value = Object.hasOwn(source, field) ? source[field] : undefined;
        if (value !== undefined && value !== null && check(value)) {
            event[field] = Array.isArray(value) ? [...(value as string[])] : (value as DiagnosticValue);
        }
    }
    return event;
}

/** A job's failure: an `error` end other than its owner's abort. */
export function isJobFailureEvent(event: DiagnosticEvent): boolean {
    return event.kind === "job" && event.phase === "error" && event.reason !== "aborted";
}

/**
 * An event that is worth a fresh `state.json`: a job's failure, a runtime fault, a failed request,
 * or a server error answer.
 */
export function isDiagnosticErrorEvent(event: DiagnosticEvent): boolean {
    switch (event.kind) {
        case "job":
            return isJobFailureEvent(event);
        case "runtime":
            return true;
        case "request":
            return event.status === "error";
        case "http":
            return typeof event.status === "number" && event.status >= 500;
        default:
            return false;
    }
}

/** The kinds and runtime origins the browser's collector writes; the server writes the others. */
const BROWSER_KINDS: ReadonlySet<string> = new Set([
    "http",
    "runtime",
    "jobLink",
    "feed",
    "sync",
    "serviceWorker",
    "page",
]);
const BROWSER_RUNTIME_ORIGINS: ReadonlySet<unknown> = new Set(["error", "unhandledrejection"]);
const SERVER_KINDS: ReadonlySet<string> = new Set(["http", "job", "request", "runtime", "lifecycle"]);

/**
 * The browser's projection: `projectDiagnosticEvent`, then only the browser's kinds and runtime
 * origins, without a server-only field (a `runtime` event's `jobId`). The collector records and
 * restores with it; the report reads the browser's events with it.
 */
export function projectBrowserEvent(input: unknown): DiagnosticEvent | null {
    const event = projectDiagnosticEvent(input);
    if (!event || !BROWSER_KINDS.has(event.kind)) {
        return null;
    }
    if (event.kind === "runtime") {
        if (!BROWSER_RUNTIME_ORIGINS.has(event.origin)) {
            return null;
        }
        delete event.jobId;
    }
    return event;
}

/** The server's projection: `projectDiagnosticEvent`, then only the server's kinds and runtime origins. */
export function projectServerEvent(input: unknown): DiagnosticEvent | null {
    const event = projectDiagnosticEvent(input);
    if (!event || !SERVER_KINDS.has(event.kind)) {
        return null;
    }
    if (event.kind === "runtime" && BROWSER_RUNTIME_ORIGINS.has(event.origin)) {
        return null;
    }
    return event;
}

/**
 * `state.json`'s fields, and the `state` of `GET /api/diagnostics` (`server/src/diagnostics/journal.ts`
 * builds it; the report reads it with `projectDiagnosticsState`). A section is null when its source
 * is missing or failed, a leaf when its value was not what it should be.
 */
export type DiagnosticsState = {
    version: 1;
    writtenAt: string;
    app: { version: string | null };
    node: string;
    platform: string;
    arch: string;
    startedAt: string;
    uptimeSec: number;
    settings: { requestHistoryContent: boolean | null; requestHistoryLimit: number | null } | null;
    history: { rows: number | null; bytes: number | null } | null;
    journal: { eventBytes: number; writeFailures: number };
    /**
     * The copies the folder's `shared/` holds (slice 10), null when it could not be read. Optional:
     * a state from before slice 10 (a report an older tab built) has none.
     */
    shared?: { files: number | null } | null;
    workers: {
        workers: number | null;
        busy: number | null;
        queued: number | null;
        spawned: number | null;
        terminated: number | null;
    } | null;
    jobs: { live: number | null } | null;
    recentJobFailures: DiagnosticEvent[];
};
