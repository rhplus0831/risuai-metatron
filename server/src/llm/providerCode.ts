import { isProviderCode } from "../../../shared/requestHistory.ts";

/**
 * The provider's error code in an answer body (`docs/plan/request-history-diagnostics.md` slice 6):
 * OpenAI's `error.code`, Google's `error.status`, Anthropic's `error.type`, from a JSON body (an
 * array: its first element, Google's stream form) or from the events of an SSE body. Only the
 * documented envelopes are read, never arbitrary content, and only a value matching
 * `PROVIDER_CODE_PATTERN` is taken.
 *
 * Best effort: a streamed body is captured up to its bound (`STREAM_CAPTURE_BYTES`), so an error
 * event past it is not seen.
 */
export function providerCodeOf(body: string): string | null {
    if (!body.includes("error")) {
        return null;
    }
    const whole = parse(body);
    if (whole !== undefined) {
        return codeOf(whole);
    }
    // An SSE body: its events, newest first, each one's `data:` lines joined.
    const events = body.split(/\r?\n\r?\n/);
    let seen = 0;
    for (let i = events.length - 1; i >= 0 && seen < MAX_SSE_EVENTS; i--) {
        const data = events[i]
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s?/, ""));
        if (data.length === 0) {
            continue;
        }
        seen++;
        const text = data.join("\n");
        if (!text.includes("error")) {
            continue;
        }
        const value = parse(text);
        const code = value === undefined ? null : codeOf(value);
        if (code) {
            return code;
        }
    }
    return null;
}

/** The SSE events read from the end of a body. */
const MAX_SSE_EVENTS = 32;

function parse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * The error objects of the known envelopes, the innermost first: a nested `error.error` (Anthropic's
 * batch result, `result.error.error`), `error` (OpenAI, Google, Anthropic), a Responses
 * `response.failed` event's `response.error`, and a batch result's `result.error`.
 */
function errorObjects(value: Record<string, unknown>): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const holder of [value, record(value.result), record(value.response)]) {
        const error = record(holder?.error);
        if (!error) {
            continue;
        }
        const inner = record(error.error);
        if (inner) {
            out.push(inner);
        }
        out.push(error);
    }
    return out;
}

function codeOf(value: unknown): string | null {
    const root = record(Array.isArray(value) ? value[0] : value);
    if (!root) {
        return null;
    }
    for (const error of errorObjects(root)) {
        for (const field of ["code", "status", "type"]) {
            const candidate = error[field];
            // Anthropic's envelope type `error` says nothing; its inner `type` is the code.
            if (isProviderCode(candidate) && candidate !== "error") {
                return candidate;
            }
        }
    }
    return null;
}
