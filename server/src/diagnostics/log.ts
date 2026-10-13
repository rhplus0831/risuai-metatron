import {
    GENERATION_ERROR_REASONS,
    GENERATION_ERROR_STAGES,
    GENERATION_ID_PATTERN,
    GENERATION_KINDS,
    type GenerationErrorReason,
    type GenerationErrorStage,
    type GenerationKind,
} from "../../../shared/jobs.ts";
import { isProviderCode } from "../../../shared/requestHistory.ts";

/**
 * The server's diagnostic events (`docs/plan/request-history-diagnostics.md` slice 6). Content-free
 * by construction (decision 9): a closed set of kinds, a closed set of fields each with its own
 * check (a value that fails it is left out), and of an error only its class name (a known one,
 * else `?`) and the first application frame of its stack (file, line, column), never its message.
 * In phase 1 an event is one console line, `[Generation] failed job=<id> request=<id> stage=<stage>
 * …`; phase 2 also writes it to the journal.
 */
export const LOG_EVENT_KINDS = [
    /** A job ended with an error other than its owner's abort. */
    "generation.failed",
    /** A send to one of the job's owner sockets threw. */
    "generation.socketSend",
    /** Closing the job's channel at its end threw. */
    "generation.channelClose",
    /** Delivering the job's end (its locks, slot, hydration, terminal) threw. */
    "generation.endDelivery",
    /** The runner's settlement could not end the job. */
    "generation.runnerSettle",
    /** A listener of the owner's socket messages threw. */
    "generation.listener",
    /** Releasing a generation the send did not close threw. */
    "generation.release",
] as const;

export type LogEventKind = (typeof LOG_EVENT_KINDS)[number];

export type LogEventFields = {
    job?: string;
    request?: string | null;
    kind?: GenerationKind;
    stage?: GenerationErrorStage | null;
    reason?: GenerationErrorReason;
    status?: number;
    providerCode?: string | null;
};

/** The error classes an event may name; any other name (a free text) is printed as `?`. */
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
/** A stack frame's location: `at fn (path:line:col)` or `at path:line:col`. */
const FRAME = /^\s+at (?:.*\()?(?:file:\/\/)?([^()\s]+):(\d{1,7}):(\d{1,7})\)?$/;
/** An application path: a file under `server/src/` or `shared/` of an absolute path. */
const APP_PATH = /\/((?:server\/src|shared)\/[A-Za-z0-9_/-]{1,200}\.[cm]?[jt]s)$/;

const checks: { [K in keyof LogEventFields]-?: (value: unknown) => boolean } = {
    job: (value) => typeof value === "string" && GENERATION_ID_PATTERN.test(value),
    request: (value) => typeof value === "string" && GENERATION_ID_PATTERN.test(value),
    kind: (value) => (GENERATION_KINDS as readonly unknown[]).includes(value),
    stage: (value) => (GENERATION_ERROR_STAGES as readonly unknown[]).includes(value),
    reason: (value) => (GENERATION_ERROR_REASONS as readonly unknown[]).includes(value),
    status: (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999,
    providerCode: isProviderCode,
};

/** The content-free projection of an event: its checked fields, then the error's name and frame. */
export function formatLogEvent(kind: LogEventKind, fields: LogEventFields, error?: unknown): string {
    const [scope, ...rest] = ((LOG_EVENT_KINDS as readonly string[]).includes(kind) ? kind : "unknown.event").split(
        ".",
    );
    const parts = [`[${scope.charAt(0).toUpperCase()}${scope.slice(1)}]`, rest.join(".")];
    for (const name of Object.keys(checks) as (keyof LogEventFields)[]) {
        const value = fields[name];
        if (value !== undefined && value !== null && checks[name](value)) {
            parts.push(`${name}=${value}`);
        }
    }
    if (error !== undefined) {
        const name = error instanceof Error ? error.name : null;
        parts.push(`error=${name !== null && ERROR_NAMES.has(name) ? name : "?"}`);
        const frame = error instanceof Error ? appFrame(error) : null;
        if (frame) {
            parts.push(`at=${frame}`);
        }
    }
    return parts.join(" ");
}

/**
 * The first application frame of `error`'s stack, or null. Only the frames are read: the stack's
 * header (the error's name and message, which may span lines) must be exactly what the error says
 * now, else nothing is read, so a message never reaches the line.
 */
function appFrame(error: Error): string | null {
    const stack = typeof error.stack === "string" ? error.stack : "";
    const header = error.message ? `${error.name}: ${error.message}` : error.name;
    if (!stack.startsWith(`${header}\n`)) {
        return null;
    }
    for (const line of stack.slice(header.length + 1).split("\n")) {
        if (!/^\s+at /.test(line)) {
            return null;
        }
        // A frame without a file location (`<anonymous>`, `native`) is passed over.
        const frame = FRAME.exec(line);
        if (!frame) {
            continue;
        }
        const path = APP_PATH.exec(frame[1]);
        if (path && !path[1].split("/").includes("..")) {
            return `${path[1]}:${frame[2]}:${frame[3]}`;
        }
    }
    return null;
}

/** Writes one diagnostic event (`formatLogEvent`). Never throws. */
export function logEvent(kind: LogEventKind, fields: LogEventFields, error?: unknown): void {
    try {
        console.error(formatLogEvent(kind, fields, error));
    } catch {}
}
