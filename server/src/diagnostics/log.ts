import {
    GENERATION_ERROR_REASONS,
    GENERATION_ERROR_STAGES,
    GENERATION_ID_PATTERN,
    GENERATION_KINDS,
    type GenerationErrorReason,
    type GenerationErrorStage,
    type GenerationKind,
} from "../../../shared/jobs.ts";
import {
    errorName,
    isProviderCode,
    RUNTIME_ORIGINS,
    sanitizeStack,
    type DiagnosticEventInput,
} from "../../../shared/diagnostics.ts";

/**
 * The server's diagnostic events (`docs/plan/request-history-diagnostics.md` slice 6). Content-free
 * by construction (decision 9): a closed set of kinds, a closed set of fields each with its own
 * check (a value that fails it is left out), and of an error only its class name (a known one,
 * else `?`) and the first application frame of its stack (file, line, column), never its message.
 * An event is one console line, `[Generation] failed job=<id> request=<id> stage=<stage> …`. With
 * a recorder (the server context's journal, slice 7), a caught fault (every kind but
 * `generation.failed`, whose fields the job's own `job` event carries) is also a `runtime` event.
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

/** An application path: a file under `server/src/` or `shared/` of an absolute path. */
const APP_PATH = /\/((?:server\/src|shared)\/[A-Za-z0-9_/-]{1,200}\.[cm]?[jt]s)$/;

/** The application-relative path of a stack frame's file, or null for any other file. */
export function serverAppPath(file: string): string | null {
    return APP_PATH.exec(file)?.[1] ?? null;
}

/**
 * An error's content-free fields: its class name (a known one, else `?`) and its application frames.
 * Never throws: an error whose `name` or `stack` accessor throws gives `?` and no frames.
 */
export function errorFields(error: unknown): { name: string; stack: string[] } {
    try {
        return { name: errorName(error), stack: sanitizeStack(error, serverAppPath) };
    } catch {
        return { name: "?", stack: [] };
    }
}

/** Records `input` to `recorder`, if any; a recorder's throw never reaches the caller. */
export function recordSafely(recorder: DiagnosticsRecorder | undefined, input: DiagnosticEventInput): void {
    try {
        recorder?.record(input);
    } catch {}
}

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
        parts.push(`error=${errorName(error)}`);
        const [frame] = sanitizeStack(error, serverAppPath, 1);
        if (frame) {
            parts.push(`at=${frame}`);
        }
    }
    return parts.join(" ");
}

/** Where an event goes besides the console: the server context's journal (`createDiagnosticsJournal`). */
export type DiagnosticsRecorder = { record(input: DiagnosticEventInput): void };

/** Writes one diagnostic event (`formatLogEvent`), and a caught fault to `recorder`. Never throws. */
export function logEvent(
    kind: LogEventKind,
    fields: LogEventFields,
    error?: unknown,
    recorder?: DiagnosticsRecorder,
): void {
    try {
        console.error(formatLogEvent(kind, fields, error));
    } catch {}
    if (recorder && (RUNTIME_ORIGINS as readonly string[]).includes(kind)) {
        try {
            recorder.record({ kind: "runtime", origin: kind, jobId: fields.job, ...errorFields(error) });
        } catch {}
    }
}
