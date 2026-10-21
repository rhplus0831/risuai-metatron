import { GENERATION_ERROR_REASONS, GENERATION_ERROR_STAGES, GENERATION_ID_PATTERN } from "../../../shared/jobs.ts";
import { isProviderCode } from "../../../shared/requestHistory.ts";
import type { JobFailureInfo } from "../alert";

/**
 * The job error alert's "Copy debug info": a content-free block built only from the named fields,
 * each checked; a field that fails its check is left out. Never the job's message, never the
 * terminal as a whole. The labels are a fixed support format, in English whatever the app's
 * language, so a developer reads every report the same way.
 */
const LABELS = {
    title: "RisuAI job failure",
    version: "Version",
    time: "Time",
    job: "Job",
    request: "Request",
    stage: "Stage",
    status: "Status",
    reason: "Reason",
    providerCode: "Provider code",
} as const;

const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

const isId = (value: unknown): value is string => typeof value === "string" && GENERATION_ID_PATTERN.test(value);

/** `failure.at` is when the tab received the job's end. */
export function jobDebugInfo(failure: JobFailureInfo, version: string): string {
    const { end } = failure;
    const time = new Date(failure.at);
    const fields: [string, string | null][] = [
        [LABELS.version, VERSION.test(version) ? version : null],
        [LABELS.time, Number.isFinite(time.getTime()) ? time.toISOString() : null],
        [LABELS.job, isId(failure.jobId) ? failure.jobId : null],
        [LABELS.request, isId(end.requestId) ? end.requestId : null],
        [LABELS.stage, (GENERATION_ERROR_STAGES as readonly unknown[]).includes(end.stage) ? end.stage! : null],
        [
            LABELS.status,
            Number.isInteger(end.status) && end.status >= 100 && end.status <= 999 ? String(end.status) : null,
        ],
        [LABELS.reason, (GENERATION_ERROR_REASONS as readonly unknown[]).includes(end.reason) ? end.reason : null],
        [LABELS.providerCode, isProviderCode(end.providerCode) ? end.providerCode : null],
    ];
    return [
        LABELS.title,
        ...fields
            .filter((field): field is [string, string] => field[1] !== null)
            .map(([label, value]) => `${label}: ${value}`),
    ].join("\n");
}
