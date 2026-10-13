import { GENERATION_ERROR_REASONS, GENERATION_ERROR_STAGES, GENERATION_ID_PATTERN, GENERATION_KINDS } from "./jobs.ts";
import { LLMFormat } from "./llm.ts";
import { BASE_LLM_MODELS } from "./llm/models.ts";
import { REQUEST_SOURCES } from "./llm/request.ts";
import { isProviderCode, PROVIDER_CODE_PATTERN } from "./requestHistory.ts";

export { isProviderCode, PROVIDER_CODE_PATTERN };

/**
 * The diagnostic events (`docs/plan/request-history-diagnostics.md` "Diagnostics folder", slice 7):
 * a closed set of kinds, each with an exact-key projection. Content-free by construction (decision
 * 9): every field has its own check, a key not in its kind's list is dropped, and a value that fails
 * its check is dropped (the rest of the event is kept). Strings are ids, enumerations, a provider
 * error code, a registered route template, a catalog model id, or an application stack frame.
 */
export const DIAGNOSTIC_EVENT_KINDS = ["http", "job", "request", "runtime", "lifecycle"] as const;

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
 * origins), the HTTP server's `error`, a failed dispose, and the server's caught faults
 * (`server/src/diagnostics/log.ts`).
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
] as const;

export type RuntimeOrigin = (typeof RUNTIME_ORIGINS)[number];

export const LIFECYCLE_PHASES = [
    "boot",
    "shutdown",
    "maintenanceStart",
    "maintenanceEnd",
    "restore",
    "import",
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
]);

export const UNKNOWN_ERROR_NAME = "?";

/** `error`'s class name when it is a known one, else `?` (a thrown non-error included). */
export function errorName(error: unknown): string {
    const name = error instanceof Error ? error.name : null;
    return name !== null && ERROR_NAMES.has(name) ? name : UNKNOWN_ERROR_NAME;
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
 * which is why the projection checks every frame again (`APP_FRAME`).
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
        if (located !== null && APP_FRAME.test(located)) {
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

/** A route template as Hono registers it (`/api/request-history/:id`, `*`), or `?` for none. */
const ROUTE_TEMPLATE = /^(?:\?|\*|\/[A-Za-z0-9_/:*{}.+-]{0,199})$/;

type Check = (value: unknown) => boolean;

const oneOf =
    (values: readonly unknown[]): Check =>
    (value) =>
        values.includes(value);
const id: Check = (value) => typeof value === "string" && GENERATION_ID_PATTERN.test(value);
const count: Check = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const httpStatus: Check = (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
const stack: Check = (value) =>
    Array.isArray(value) &&
    value.length <= MAX_STACK_FRAMES &&
    value.every((frame) => typeof frame === "string" && APP_FRAME.test(frame));

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
        route: (value) => typeof value === "string" && ROUTE_TEMPLATE.test(value),
        status: httpStatus,
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
        replaced: (value) => typeof value === "boolean",
    },
};

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
    for (const [field, check] of Object.entries(SCHEMAS[kind as DiagnosticEventKind])) {
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
