// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLogEvent, LOG_EVENT_KINDS, logEvent } from "../diagnostics/log.ts";
import { GenerationRunnerError } from "../jobs/generationJobs.ts";
import { LuaJobFatalError } from "../lua/bindings.ts";

// Request history slice 6 (`docs/plan/request-history-diagnostics.md`): the server's content-free
// diagnostic events (`server/src/diagnostics/log.ts`). Every field is checked against its own
// pattern or enumeration, an error contributes only a known class name and the first application
// frame of its stack, and a message never reaches the line (decision 9).

const JOB = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
const REQUEST = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
/** An error whose stack is exactly `stack` (the header must be the error's own name and message). */
const withStack = (error: Error, frames: string[]) => {
    error.stack = [error.message ? `${error.name}: ${error.message}` : error.name, ...frames].join("\n");
    return error;
};
const APP_FRAME = "    at runSpeaker (/srv/app/server/src/prompt/runner.ts:1234:17)";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("formatLogEvent", () => {
    it("prints the kind as its scope and name, then every checked field in a fixed order", () => {
        expect(
            formatLogEvent("generation.failed", {
                providerCode: "rate_limit_exceeded",
                status: 429,
                reason: "failed",
                stage: "request",
                kind: "send",
                request: REQUEST,
                job: JOB,
            }),
        ).toBe(
            `[Generation] failed job=${JOB} request=${REQUEST} kind=send stage=request reason=failed status=429 providerCode=rate_limit_exceeded`,
        );
        expect(formatLogEvent("generation.release", { job: JOB })).toBe(`[Generation] release job=${JOB}`);
        expect(LOG_EVENT_KINDS).toContain("generation.failed");
    });

    it("leaves out a field that fails its check: a free text as an id, a job kind, stage, or reason outside its list, a non-integer or out-of-range status, a text as a provider code, null, undefined", () => {
        expect(
            formatLogEvent("generation.failed", {
                job: "Private Character",
                request: "r/1",
                kind: "PrivateCharacterName" as never,
                stage: "parsing" as never,
                reason: "exploded" as never,
                status: 500.5,
                providerCode: "rate limit exceeded",
            }),
        ).toBe("[Generation] failed");
        expect(
            formatLogEvent("generation.failed", {
                job: undefined,
                request: null,
                stage: null,
                providerCode: null,
                status: 1000,
            }),
        ).toBe("[Generation] failed");
        expect(formatLogEvent("generation.failed", { status: -1 })).toBe("[Generation] failed");
        expect(formatLogEvent("generation.failed", { status: 0, kind: "command", stage: "setup" })).toBe(
            "[Generation] failed kind=command stage=setup status=0",
        );
        // A field the type does not name is never printed.
        expect(formatLogEvent("generation.failed", { message: "secret text" } as never)).toBe("[Generation] failed");
    });

    it("prints an unknown kind as `[Unknown] event`, never the given text", () => {
        expect(formatLogEvent("Private Character Name" as never, { job: JOB })).toBe(`[Unknown] event job=${JOB}`);
    });

    it("names an error by a known class only, and `?` for any other name or a thrown non-error", () => {
        expect(formatLogEvent("generation.release", {}, new GenerationRunnerError(500, "x"))).toBe(
            "[Generation] release error=GenerationRunnerError",
        );
        expect(formatLogEvent("generation.release", {}, new LuaJobFatalError("x"))).toBe(
            "[Generation] release error=LuaJobFatalError",
        );
        expect(formatLogEvent("generation.release", {}, new TypeError("x"))).toBe(
            "[Generation] release error=TypeError",
        );
        class PrivateCharacterName extends Error {
            constructor() {
                super("x");
                this.name = "PrivateCharacterName";
            }
        }
        expect(formatLogEvent("generation.release", {}, new PrivateCharacterName())).toBe(
            "[Generation] release error=?",
        );
        const renamed = new Error("x");
        renamed.name = "Lua error: private text";
        expect(formatLogEvent("generation.release", {}, renamed)).toBe("[Generation] release error=?");
        expect(formatLogEvent("generation.release", {}, "a thrown string with private text")).toBe(
            "[Generation] release error=?",
        );
        // Any object with a listed `name` is named (a DOMException, an error of another realm); a free-text
        // or throwing `name` is `?`.
        expect(formatLogEvent("generation.release", {}, { name: "Error", message: "m" })).toBe(
            "[Generation] release error=Error",
        );
        expect(formatLogEvent("generation.release", {}, { name: "AliceError", message: "m" })).toBe(
            "[Generation] release error=?",
        );
        expect(
            formatLogEvent(
                "generation.release",
                {},
                {
                    get name(): string {
                        throw new Error("no");
                    },
                },
            ),
        ).toBe("[Generation] release error=?");
        expect(formatLogEvent("generation.release", {}, null)).toBe("[Generation] release error=?");
        // No error argument: no error part.
        expect(formatLogEvent("generation.release", {}, undefined)).toBe("[Generation] release");
    });

    it("prints the first application frame (file under server/src or shared, line, column), passing over other frames", () => {
        const error = withStack(new Error("boom"), [
            "    at new Promise (<anonymous>)",
            "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
            "    at Object.<anonymous> (/srv/app/node_modules/vitest/dist/index.js:1:1)",
            APP_FRAME,
            "    at async runPromptJob (/srv/app/server/src/prompt/runner.ts:260:9)",
        ]);
        expect(formatLogEvent("generation.release", {}, error)).toBe(
            "[Generation] release error=Error at=server/src/prompt/runner.ts:1234:17",
        );
        // A frame without a function name, a `file://` URL, a `shared/` file, Windows-style drive paths are not app paths.
        expect(
            formatLogEvent(
                "generation.release",
                {},
                withStack(new Error("boom"), ["    at file:///srv/app/shared/cbs/evaluator.ts:9:3"]),
            ),
        ).toBe("[Generation] release error=Error at=shared/cbs/evaluator.ts:9:3");
        expect(
            formatLogEvent(
                "generation.release",
                {},
                withStack(new Error("boom"), ["    at /srv/app/server/src/x.mjs:1:2"]),
            ),
        ).toBe("[Generation] release error=Error at=server/src/x.mjs:1:2");
        expect(
            formatLogEvent(
                "generation.release",
                {},
                withStack(new Error("boom"), ["    at fn (C:\\app\\server\\src\\prompt\\runner.ts:1:2)"]),
            ),
        ).toBe("[Generation] release error=Error");
    });

    it("never prints the message: a message holding frame-like text, spanning lines, or naming an application file", () => {
        const message = `private text shared/private-character-name.ts:123:45\n    at shared/private-character-name.ts:123:45\n    at ${APP_FRAME.trim()}`;
        const real = new GenerationRunnerError(500, message);
        const line = formatLogEvent("generation.release", { job: JOB }, real);
        expect(line).not.toContain("private");
        expect(line).not.toContain("123:45");
        expect(line).toMatch(
            /^\[Generation\] release job=[0-9a-f-]+ error=GenerationRunnerError( at=server\/src\/[^ ]+)?$/,
        );
        // The header is the message as it is now: a message changed after the stack was made, or a
        // stack that does not start with the header, yields no frame at all.
        const changed = withStack(new Error("original"), [APP_FRAME]);
        changed.message = "edited";
        expect(formatLogEvent("generation.release", {}, changed)).toBe("[Generation] release error=Error");
        const foreign = new Error("boom");
        foreign.stack = `Something else: boom\n${APP_FRAME}`;
        expect(formatLogEvent("generation.release", {}, foreign)).toBe("[Generation] release error=Error");
        const empty = new Error("");
        empty.stack = `Error\n${APP_FRAME}`;
        expect(formatLogEvent("generation.release", {}, empty)).toBe(
            "[Generation] release error=Error at=server/src/prompt/runner.ts:1234:17",
        );
        // Text after the header that is not a frame line stops the read: nothing past it is printed.
        const trailing = withStack(new Error("boom"), ["private text", APP_FRAME]);
        expect(formatLogEvent("generation.release", {}, trailing)).toBe("[Generation] release error=Error");
        // No stack, or a stack that is not a string.
        const bare = new Error("boom");
        bare.stack = undefined;
        expect(formatLogEvent("generation.release", {}, bare)).toBe("[Generation] release error=Error");
        const odd = new Error("boom");
        (odd as { stack: unknown }).stack = 42;
        expect(formatLogEvent("generation.release", {}, odd)).toBe("[Generation] release error=Error");
    });

    it("prints only the application part of a path: a frame outside the app roots or under node_modules gives no frame", () => {
        expect(
            formatLogEvent(
                "generation.release",
                {},
                withStack(new Error("boom"), [
                    "    at fn (/srv/app/src/ts/private.ts:1:1)",
                    "    at fn (/srv/app/server/src/../private/leak.ts:1:1)",
                    "    at fn (/srv/app/server/src/x.ts.bak:1:1)",
                    "    at fn (/srv/app/server/src/x.ts:1)",
                ]),
            ),
        ).toBe("[Generation] release error=Error");
    });
});

describe("logEvent", () => {
    it("writes the formatted line with console.error and never throws, also for an error whose accessors throw", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        logEvent("generation.failed", { job: JOB, kind: "send", reason: "failed", status: 500, stage: "tail" });
        expect(error).toHaveBeenCalledWith(
            `[Generation] failed job=${JOB} kind=send stage=tail reason=failed status=500`,
        );
        const hostile = new Error("x");
        Object.defineProperty(hostile, "stack", {
            get() {
                throw new Error("no stack for you");
            },
        });
        expect(() => logEvent("generation.release", {}, hostile)).not.toThrow();
        error.mockImplementationOnce(() => {
            throw new Error("console broke");
        });
        expect(() => logEvent("generation.release", {})).not.toThrow();
    });
});
