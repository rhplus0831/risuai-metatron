// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PROVIDER_CODE_PATTERN } from "../../../shared/requestHistory.ts";
import { providerCodeOf } from "../llm/providerCode.ts";

// Request history slice 6 (`docs/plan/request-history-diagnostics.md`): the provider's error code
// read from a captured answer body (`server/src/llm/providerCode.ts`). Only the documented
// envelopes and fields, only a value matching `PROVIDER_CODE_PATTERN` (decision 9), never a message.

const sse = (...events: (string | string[])[]) =>
    events
        .map((event) => (Array.isArray(event) ? event : [event]).map((line) => `data: ${line}`).join("\n"))
        .join("\n\n") + "\n\n";

describe("providerCodeOf", () => {
    it("reads the known envelopes: OpenAI's error.code, Google's error.status (its numeric code skipped), Anthropic's error.type", () => {
        expect(
            providerCodeOf(
                JSON.stringify({
                    error: {
                        message: "Rate limit reached",
                        type: "requests",
                        param: null,
                        code: "rate_limit_exceeded",
                    },
                }),
            ),
        ).toBe("rate_limit_exceeded");
        expect(
            providerCodeOf(
                JSON.stringify({
                    error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" },
                }),
            ),
        ).toBe("RESOURCE_EXHAUSTED");
        expect(
            providerCodeOf(
                JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
            ),
        ).toBe("overloaded_error");
    });

    it("falls through the fields in order (code, status, type) past a value that is not a code, and skips Anthropic's envelope type `error`", () => {
        expect(
            providerCodeOf(JSON.stringify({ error: { code: null, type: "invalid_request_error", message: "m" } })),
        ).toBe("invalid_request_error");
        expect(
            providerCodeOf(JSON.stringify({ error: { code: "has a space", status: "", type: "server_error" } })),
        ).toBe("server_error");
        expect(providerCodeOf(JSON.stringify({ error: { type: "error", message: "m" } }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ error: { code: "error", type: "overloaded_error" } }))).toBe(
            "overloaded_error",
        );
    });

    it("reads Google's stream form (an array's first element), Anthropic's batch result (result.error.error first), and a Responses `response.failed` event", () => {
        expect(
            providerCodeOf(JSON.stringify([{ error: { code: 400, status: "INVALID_ARGUMENT", message: "m" } }])),
        ).toBe("INVALID_ARGUMENT");
        expect(providerCodeOf(JSON.stringify([]))).toBeNull();
        expect(
            providerCodeOf(
                JSON.stringify({
                    custom_id: "x",
                    result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error" } } },
                }),
            ),
        ).toBe("invalid_request_error");
        expect(
            providerCodeOf(
                JSON.stringify({
                    type: "response.failed",
                    response: { id: "r", status: "failed", error: { code: "server_error", message: "m" } },
                }),
            ),
        ).toBe("server_error");
    });

    it("never answers a message or another free text, a non-string, or a value outside the pattern", () => {
        expect(providerCodeOf(JSON.stringify({ error: { message: "rate_limit_exceeded" } }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ error: "rate_limit_exceeded" }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ error: { code: 42 } }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ error: { code: "x".repeat(65) } }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ error: { code: "a/b" } }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ error: { code: "코드" } }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ error: { code: "" } }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ error: null }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ error: [{ code: "x" }] }))).toBeNull();
        // Only the documented holders: a code anywhere else in the body is not read.
        expect(providerCodeOf(JSON.stringify({ choices: [{ error: { code: "nested" } }] }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ result: { error: { nested: { code: "deep" } } } }))).toBeNull();
        expect(providerCodeOf(JSON.stringify({ code: "rate_limit_exceeded" }))).toBeNull();
    });

    it("answers null for a body without `error`, one that is neither JSON nor SSE, or an empty one", () => {
        expect(providerCodeOf("")).toBeNull();
        expect(providerCodeOf(JSON.stringify({ choices: [{ message: { content: "hi" } }] }))).toBeNull();
        expect(providerCodeOf("<html>error 502</html>")).toBeNull();
        expect(providerCodeOf("error: not json {")).toBeNull();
    });

    it("reads an SSE body's events, newest first, joining an event's data lines, past `[DONE]`, chunks, and bare error words", () => {
        const chunk = JSON.stringify({ choices: [{ delta: { content: "no error here" } }] });
        expect(
            providerCodeOf(
                sse(chunk, JSON.stringify({ error: { message: "Overloaded", code: "server_overloaded" } }), "[DONE]"),
            ),
        ).toBe("server_overloaded");
        // Anthropic's event: an `event:` line, then the data split over two lines.
        const anthropic =
            `event: message_start\ndata: {"type":"message_start"}\n\n` +
            `event: error\ndata: {"type":"error",\ndata: "error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`;
        expect(providerCodeOf(anthropic)).toBe("overloaded_error");
        expect(providerCodeOf(anthropic.replace(/\n/g, "\r\n"))).toBe("overloaded_error");
        // The newest event with a code wins; a later event without one is passed over.
        expect(
            providerCodeOf(
                sse(
                    JSON.stringify({ error: { code: "older" } }),
                    JSON.stringify({ error: { code: "newer" } }),
                    JSON.stringify({ choices: [] }),
                ),
            ),
        ).toBe("newer");
        // A body cut inside its last event (the capture bound): the earlier whole event is read.
        expect(providerCodeOf(sse(JSON.stringify({ error: { code: "whole" } })) + 'data: {"error":{"code":"cu')).toBe(
            "whole",
        );
    });

    it("reads at most the last 32 SSE events: an error further back is not seen (best effort within the capture)", () => {
        const chunk = JSON.stringify({ choices: [{ delta: { content: "error" } }] });
        const error = JSON.stringify({ error: { code: "too_far" } });
        expect(providerCodeOf(sse(error, ...Array.from({ length: 31 }, () => chunk)))).toBe("too_far");
        expect(providerCodeOf(sse(error, ...Array.from({ length: 32 }, () => chunk)))).toBeNull();
        // Events without data lines (comments, `event:` only) are not counted.
        expect(
            providerCodeOf(sse(error, ...Array.from({ length: 31 }, () => chunk)) + ": keep-alive\n\n".repeat(5)),
        ).toBe("too_far");
    });

    it("every answer matches PROVIDER_CODE_PATTERN", () => {
        for (const body of [
            JSON.stringify({ error: { code: "a.b-c_D9" } }),
            JSON.stringify({ error: { code: "x".repeat(64) } }),
            sse(JSON.stringify({ error: { type: "overloaded_error" } })),
        ]) {
            const code = providerCodeOf(body);
            expect(code).not.toBeNull();
            expect(PROVIDER_CODE_PATTERN.test(code!)).toBe(true);
        }
    });
});
