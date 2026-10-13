// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
    apiRouteTemplate,
    APP_FRAME,
    CLIENT_FRAME,
    CUSTOM_MODEL,
    DIAGNOSTIC_EVENT_KINDS,
    DIAGNOSTICS_PATH,
    type DiagnosticEvent,
    diagnosticModel,
    errorName,
    isApiPath,
    isDiagnosticErrorEvent,
    isJobFailureEvent,
    isProviderCode,
    isStackFrame,
    LIFECYCLE_PHASES,
    MAX_STACK_FRAMES,
    projectDiagnosticEvent,
    ROUTE_TEMPLATES,
    RUNTIME_ORIGINS,
    sanitizeStack,
    UNKNOWN_ERROR_NAME,
} from "../diagnostics.ts";
import { BASE_LLM_MODELS } from "../llm/models.ts";

// Request history slices 7 and 8 (`docs/plan/request-history-diagnostics.md`, "Diagnostics folder"):
// the content-free projection of a diagnostic event (`shared/diagnostics.ts`). Every kind has an
// exact key list, every field its own check, and a value that fails is dropped on its own
// (decision 9): no free text, no URL, no path outside the application, no message. The tests feed
// each field what an attacker or a bug would (names, paths, queries, forged frames) and look at
// what is kept. Slice 8 adds the browser's kinds, the route table (`ROUTE_TEMPLATES`,
// `apiRouteTemplate`, `isApiPath`), the browser frames (`CLIENT_FRAME`), and the duck-typed name.

const ID = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
const AT = 1_700_000_000_000;
const CATALOG_MODEL = BASE_LLM_MODELS[0].id;

/** An error whose stack is exactly `header` (or the error's own) followed by `frames`. */
function withStack(error: Error, frames: string[], header?: string): Error {
    const own = error.message ? `${error.name}: ${error.message}` : error.name;
    error.stack = [header ?? own, ...frames].join("\n");
    return error;
}
/** The application-relative path of an absolute frame file, as the server maps it. */
const appPath = (file: string) =>
    /\/((?:server\/src|shared)\/[A-Za-z0-9_/-]{1,200}\.[cm]?[jt]s)$/.exec(file)?.[1] ?? null;

describe("projectDiagnosticEvent", () => {
    it("refuses anything that is not an event: a non-object, an unknown kind, a time that is not a non-negative integer", () => {
        expect(projectDiagnosticEvent(null)).toBeNull();
        expect(projectDiagnosticEvent("http")).toBeNull();
        expect(projectDiagnosticEvent({ at: AT })).toBeNull();
        expect(projectDiagnosticEvent({ at: AT, kind: "script" })).toBeNull();
        expect(projectDiagnosticEvent({ at: AT, kind: "Private Name" })).toBeNull();
        expect(projectDiagnosticEvent({ kind: "http" })).toBeNull();
        expect(projectDiagnosticEvent({ at: AT + 0.5, kind: "http" })).toBeNull();
        expect(projectDiagnosticEvent({ at: -1, kind: "http" })).toBeNull();
        expect(projectDiagnosticEvent({ at: "1700000000000", kind: "http" })).toBeNull();
        expect(projectDiagnosticEvent({ at: Number.MAX_SAFE_INTEGER + 2, kind: "http" })).toBeNull();
        expect(DIAGNOSTIC_EVENT_KINDS).toEqual([
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
        ]);
    });

    it("keeps only the kind's listed keys, drops null and undefined, and returns a new object with a copied stack", () => {
        const stack = ["server/src/prompt/runner.ts:1:2"];
        const input = {
            at: AT,
            kind: "runtime",
            origin: "uncaughtException",
            stack,
            message: "the secret message",
            prompt: "a prompt",
            url: "https://user:pw@example.com/?q=1",
            jobId: null,
            name: undefined,
            route: "/api/x",
            __proto__: { phase: "boot" },
        };
        const event = projectDiagnosticEvent(input)!;
        expect(event).toEqual({ at: AT, kind: "runtime", origin: "uncaughtException", stack });
        expect(event.stack).not.toBe(stack);
        expect(Object.keys(event)).toEqual(["at", "kind", "origin", "stack"]);
        // A field only reachable through the prototype is not the event's.
        expect(projectDiagnosticEvent(Object.create({ at: AT, kind: "lifecycle", phase: "boot" }))).toEqual({
            at: AT,
            kind: "lifecycle",
        });
        expect(projectDiagnosticEvent({ at: AT, kind: "lifecycle", __proto__: { phase: "boot" } })).toEqual({
            at: AT,
            kind: "lifecycle",
        });
    });

    it("http: a listed method, a route from `ROUTE_TEMPLATES` only (never a path, a URL, or a template of its own), a status 100–599, a failure, an integer duration", () => {
        const full = {
            at: AT,
            kind: "http",
            method: "POST",
            route: "/api/request-history/:id",
            status: 404,
            durationMs: 12,
        };
        expect(projectDiagnosticEvent(full)).toEqual(full);
        for (const route of ROUTE_TEMPLATES) {
            expect(projectDiagnosticEvent({ at: AT, kind: "http", route }), route).toHaveProperty("route", route);
        }
        expect(ROUTE_TEMPLATES).toContain(DIAGNOSTICS_PATH);
        const refusedRoutes = [
            "*",
            "/api/generations/:id/ws",
            "/a/{b}/+c.d-e_f",
            "/Alice/private-chat",
            "/api/resources/characters/alice",
            "/api/resources/:kind/",
            "/api/read?file=secret",
            "/api/x?a=1&b=2",
            "/api/x#frag",
            "/Alice Smith",
            "/api/%2e%2e",
            "api/x",
            "",
            `/${"a".repeat(199)}`,
            "https://example.com/",
            42,
        ];
        for (const route of refusedRoutes) {
            expect(projectDiagnosticEvent({ at: AT, kind: "http", route }), String(route)).not.toHaveProperty("route");
        }
        expect(projectDiagnosticEvent({ at: AT, kind: "http", failure: "timeout" })).toHaveProperty(
            "failure",
            "timeout",
        );
        expect(projectDiagnosticEvent({ at: AT, kind: "http", failure: "rejected" })).toHaveProperty(
            "failure",
            "rejected",
        );
        for (const failure of ["network", "aborted", true, ""]) {
            expect(projectDiagnosticEvent({ at: AT, kind: "http", failure }), String(failure)).not.toHaveProperty(
                "failure",
            );
        }
        for (const method of ["PROPFIND", "get", "", 1]) {
            expect(projectDiagnosticEvent({ at: AT, kind: "http", method }), String(method)).not.toHaveProperty(
                "method",
            );
        }
        for (const status of [99, 600, 200.5, "404", NaN]) {
            expect(projectDiagnosticEvent({ at: AT, kind: "http", status }), String(status)).not.toHaveProperty(
                "status",
            );
        }
        expect(projectDiagnosticEvent({ at: AT, kind: "http", status: 100 })).toHaveProperty("status", 100);
        expect(projectDiagnosticEvent({ at: AT, kind: "http", status: 599 })).toHaveProperty("status", 599);
        for (const durationMs of [-1, 1.5, "12", Infinity]) {
            expect(projectDiagnosticEvent({ at: AT, kind: "http", durationMs })).not.toHaveProperty("durationMs");
        }
        expect(projectDiagnosticEvent({ at: AT, kind: "http", durationMs: 0 })).toHaveProperty("durationMs", 0);
    });

    it("job: the phase, ids by the generation id pattern, the kind, stage, and reason by their lists, the status, a provider code, the duration", () => {
        const full = {
            at: AT,
            kind: "job",
            phase: "error",
            jobId: ID,
            jobKind: "send",
            stage: "request",
            reason: "failed",
            status: 429,
            requestId: ID,
            providerCode: "rate_limit_exceeded",
            durationMs: 1500,
        };
        expect(projectDiagnosticEvent(full)).toEqual(full);
        expect(
            projectDiagnosticEvent({
                at: AT,
                kind: "job",
                phase: "started",
                jobId: "Private Character",
                jobKind: "PrivateKind",
                stage: "parsing",
                reason: "exploded: secret",
                status: 1000,
                requestId: "r/1",
                providerCode: "rate limit exceeded",
                durationMs: -5,
                message: "secret",
            }),
        ).toEqual({ at: AT, kind: "job" });
        expect(projectDiagnosticEvent({ at: AT, kind: "job", jobId: "a".repeat(65) })).toEqual({ at: AT, kind: "job" });
        expect(projectDiagnosticEvent({ at: AT, kind: "job", providerCode: "a".repeat(65) })).toEqual({
            at: AT,
            kind: "job",
        });
        expect(isProviderCode("invalid_request_error")).toBe(true);
        expect(isProviderCode("not a code")).toBe(false);
    });

    it("request: the source and status by their lists, the provider only as an `LLMFormat` name, the model only as a catalog id or `custom`", () => {
        const full = {
            at: AT,
            kind: "request",
            requestId: ID,
            jobId: ID,
            source: "send",
            status: "error",
            provider: "OpenAICompatible",
            model: CATALOG_MODEL,
            httpStatus: 503,
            providerCode: "overloaded_error",
            durationMs: 2000,
            requestBytes: 1234,
            responseBytes: 0,
        };
        expect(projectDiagnosticEvent(full)).toEqual(full);
        expect(projectDiagnosticEvent({ at: AT, kind: "request", model: CUSTOM_MODEL })).toHaveProperty(
            "model",
            CUSTOM_MODEL,
        );
        expect(
            projectDiagnosticEvent({
                at: AT,
                kind: "request",
                source: "Alice",
                status: "pending",
                provider: "Alice's Provider",
                model: "alice/private-model:latest",
                httpStatus: 0,
                providerCode: "",
                requestBytes: 1.5,
                responseBytes: -1,
                url: "https://example.com/v1?key=secret",
                error: "secret message",
                prompt: "secret prompt",
            }),
        ).toEqual({ at: AT, kind: "request" });
        // A format's numeric value, or a model name that is not a catalog id, is not a provider or a model.
        expect(projectDiagnosticEvent({ at: AT, kind: "request", provider: 0 })).toEqual({ at: AT, kind: "request" });
        expect(projectDiagnosticEvent({ at: AT, kind: "request", model: "Private Model" })).toEqual({
            at: AT,
            kind: "request",
        });
    });

    it("runtime: the origin by its list, the error name only as a known class or `?`, the stack only as application frames", () => {
        const stack = [
            "server/src/prompt/runner.ts:1234:17",
            "shared/cbs/parser.ts:1:1",
            "server/src/jobs/generationJobs.mts:2:3",
            "shared/x.cjs:3:4",
            "server/src/a.js:4:5",
        ];
        const full = { at: AT, kind: "runtime", origin: "unhandledRejection", jobId: ID, name: "TypeError", stack };
        expect(projectDiagnosticEvent(full)).toEqual(full);
        expect(RUNTIME_ORIGINS).toContain("generation.release");
        expect(projectDiagnosticEvent({ at: AT, kind: "runtime", name: UNKNOWN_ERROR_NAME })).toHaveProperty(
            "name",
            "?",
        );
        expect(
            projectDiagnosticEvent({
                at: AT,
                kind: "runtime",
                origin: "script",
                name: "AliceError: secret",
                stack: "server/src/x.ts:1:1",
                message: "secret",
            }),
        ).toEqual({ at: AT, kind: "runtime" });
        // One bad frame drops the whole stack (the list is a single value).
        const forged = [
            ["/home/alice/private.ts:1:2"],
            ["secret:1:2"],
            ["server/src/../private/leak.ts:1:1"],
            ["server/src/x.ts.bak:1:1"],
            ["server/src/x.ts:1"],
            ["server/src/x.ts:1:2:3"],
            ["file:///srv/server/src/x.ts:1:1"],
            ["node_modules/hono/dist/x.js:1:1"],
            ["server/src/x.ts:12345678:1"],
            ["server/src/x.ts:1:1", 42],
            ["server/src/x.ts:1:1", "Alice said hi"],
            [`server/src/${"a".repeat(201)}.ts:1:1`],
            Array.from({ length: MAX_STACK_FRAMES + 1 }, () => "server/src/x.ts:1:1"),
        ];
        for (const stack of forged) {
            expect(projectDiagnosticEvent({ at: AT, kind: "runtime", stack }), JSON.stringify(stack)).toEqual({
                at: AT,
                kind: "runtime",
            });
        }
        expect(
            projectDiagnosticEvent({
                at: AT,
                kind: "runtime",
                stack: Array.from({ length: MAX_STACK_FRAMES }, () => "server/src/x.ts:1:1"),
            })!.stack,
        ).toHaveLength(MAX_STACK_FRAMES);
        expect(projectDiagnosticEvent({ at: AT, kind: "runtime", stack: [] })).toEqual({
            at: AT,
            kind: "runtime",
            stack: [],
        });
        expect(APP_FRAME.test("server/src/x.ts:1:1")).toBe(true);
    });

    it("runtime stacks: a browser frame (a dev source under `src/` or `shared/`, a built chunk with Vite's hash) is kept, a path of any other shape dropped", () => {
        const accepted = [
            "src/ts/private.ts:1:1",
            "src/lib/ChatScreens/Chat.svelte:1:2",
            "src/ts/storage/resourceSync.svelte.ts:3:4",
            "src/ts/x.svelte.js:1:1",
            "src/x.mjs:1:1",
            "shared/cbs/parser.ts:5:6",
            "assets/index-BZ0RKwIv.js:1:1",
            "assets/index-client-BZ0RKwIv.js:1:1",
            "assets/preload-helper-BFxt1TtF.js:1:1",
            "assets/rolldown-runtime-DkW27tQK.js:1:1",
            "assets/disclose-version-CPEFmoaC.js:1:1",
            "assets/a.b.c-12345678.js:1234567:1234567",
        ];
        for (const frame of accepted) {
            expect(isStackFrame(frame), frame).toBe(true);
            expect(CLIENT_FRAME.test(frame), frame).toBe(true);
            expect(projectDiagnosticEvent({ at: AT, kind: "runtime", stack: [frame] })).toHaveProperty("stack", [
                frame,
            ]);
        }
        const refused = [
            "assets/index.js:1:1",
            "assets/x-1234567.js:1:1",
            "assets/x-123456789.js:1:1",
            "assets/../src/x-12345678.js:1:1",
            "assets/dir/x-12345678.js:1:1",
            "assets/x-12345678.js.map:1:1",
            "assets/x-12345678.css:1:1",
            "assets/Alice Private-12345678.js:1:1",
            "src/x.ts?t=1:1:1",
            "src/Alice Private.ts:1:1",
            "src/x.ts.bak:1:1",
            "src/x.tsx:1:1",
            "src/x.json:1:1",
            "src/../server/src/x.ts:1:1",
            "src/x.svelte.ts.map:1:1",
            "public/sw.js:1:1",
            "node_modules/.vite/deps/x.js:1:1",
            "/src/x.ts:1:1",
            "http://localhost:3000/src/x.ts:1:1",
            "src/x.ts:1",
            "src/x.ts:12345678:1",
            `src/${"a".repeat(201)}.ts:1:1`,
            "src/.ts:1:1",
        ];
        for (const frame of refused) {
            expect(isStackFrame(frame), frame).toBe(false);
            expect(projectDiagnosticEvent({ at: AT, kind: "runtime", stack: [frame] }), frame).toEqual({
                at: AT,
                kind: "runtime",
            });
        }
        expect(isStackFrame(42)).toBe(false);
    });

    it("jobLink: the phase, a lowercase UUID job id (the server's shape, never the relaxed generation id), the attempt, a close code 1000–4999, `terminal`", () => {
        const full = { at: AT, kind: "jobLink", phase: "reattach", jobId: ID, attempt: 3, code: 4001, terminal: true };
        expect(projectDiagnosticEvent(full)).toEqual(full);
        for (const jobId of ["job-1", "Alice", ID.toUpperCase(), `${ID}0`, ID.slice(1), "a".repeat(36)]) {
            expect(projectDiagnosticEvent({ at: AT, kind: "jobLink", jobId }), jobId).toEqual({
                at: AT,
                kind: "jobLink",
            });
        }
        expect(
            projectDiagnosticEvent({
                at: AT,
                kind: "jobLink",
                phase: "opened",
                attempt: -1,
                code: 999,
                terminal: 1,
                reason: "x",
            }),
        ).toEqual({ at: AT, kind: "jobLink" });
        expect(projectDiagnosticEvent({ at: AT, kind: "jobLink", code: 5000 })).toEqual({ at: AT, kind: "jobLink" });
        expect(projectDiagnosticEvent({ at: AT, kind: "jobLink", code: 1000 })).toHaveProperty("code", 1000);
    });

    it("feed, sync, serviceWorker, page: the phases by their lists, counts, a close code; `repeat` and `lastAt` on every kind", () => {
        const feed = { at: AT, kind: "feed", phase: "disconnected", attempt: 0, code: 1006 };
        expect(projectDiagnosticEvent(feed)).toEqual(feed);
        expect(projectDiagnosticEvent({ at: AT, kind: "feed", phase: "hello", attempt: "1", code: 1.5 })).toEqual({
            at: AT,
            kind: "feed",
        });
        const sync = { at: AT, kind: "sync", phase: "conflict", records: 1, chats: 0, orders: 2, generating: 1 };
        expect(projectDiagnosticEvent(sync)).toEqual(sync);
        expect(projectDiagnosticEvent({ at: AT, kind: "sync", phase: "reload", reason: "serviceWorker" })).toEqual({
            at: AT,
            kind: "sync",
            phase: "reload",
            reason: "serviceWorker",
        });
        expect(
            projectDiagnosticEvent({
                at: AT,
                kind: "sync",
                phase: "halt",
                reason: "Alice",
                records: -1,
                generating: true,
                ids: [],
            }),
        ).toEqual({ at: AT, kind: "sync" });
        expect(projectDiagnosticEvent({ at: AT, kind: "serviceWorker", phase: "initFailed" })).toEqual({
            at: AT,
            kind: "serviceWorker",
            phase: "initFailed",
        });
        expect(projectDiagnosticEvent({ at: AT, kind: "serviceWorker", phase: "updated", scope: "/" })).toEqual({
            at: AT,
            kind: "serviceWorker",
        });
        expect(projectDiagnosticEvent({ at: AT, kind: "page", phase: "offline" })).toEqual({
            at: AT,
            kind: "page",
            phase: "offline",
        });
        expect(projectDiagnosticEvent({ at: AT, kind: "page", phase: "unload", url: "/x" })).toEqual({
            at: AT,
            kind: "page",
        });
        for (const kind of DIAGNOSTIC_EVENT_KINDS) {
            expect(projectDiagnosticEvent({ at: AT, kind, repeat: 3, lastAt: AT + 1 }), kind).toEqual({
                at: AT,
                kind,
                repeat: 3,
                lastAt: AT + 1,
            });
            expect(projectDiagnosticEvent({ at: AT, kind, repeat: 0.5, lastAt: "later" }), kind).toEqual({
                at: AT,
                kind,
            });
        }
    });

    it("lifecycle: the phase by its list and `replaced` as a boolean only", () => {
        for (const phase of LIFECYCLE_PHASES) {
            expect(projectDiagnosticEvent({ at: AT, kind: "lifecycle", phase })).toEqual({
                at: AT,
                kind: "lifecycle",
                phase,
            });
        }
        expect(projectDiagnosticEvent({ at: AT, kind: "lifecycle", phase: "maintenanceEnd", replaced: false })).toEqual(
            { at: AT, kind: "lifecycle", phase: "maintenanceEnd", replaced: false },
        );
        expect(
            projectDiagnosticEvent({ at: AT, kind: "lifecycle", phase: "restored", replaced: "yes", epoch: "e1" }),
        ).toEqual({ at: AT, kind: "lifecycle" });
    });
});

describe("sanitizeStack", () => {
    it("keeps the application frames as `path:line:col`, passing over dependencies, Node's internals, and frames without a location", () => {
        const error = withStack(new TypeError("boom"), [
            "    at runSpeaker (/srv/app/server/src/prompt/runner.ts:1234:17)",
            "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
            "    at <anonymous>",
            "    at native",
            "    at dispatch (/srv/app/node_modules/hono/dist/compose.js:29:23)",
            "    at file:///srv/app/shared/cbs/parser.ts:10:2",
            "    at async run (/srv/app/server/src/jobs/generationJobs.ts:700:9)",
        ]);
        expect(sanitizeStack(error, appPath)).toEqual([
            "server/src/prompt/runner.ts:1234:17",
            "shared/cbs/parser.ts:10:2",
            "server/src/jobs/generationJobs.ts:700:9",
        ]);
        expect(sanitizeStack(error, appPath, 1)).toEqual(["server/src/prompt/runner.ts:1234:17"]);
        expect(sanitizeStack(error, appPath, 2)).toEqual([
            "server/src/prompt/runner.ts:1234:17",
            "shared/cbs/parser.ts:10:2",
        ]);
        // A path the mapper refuses (outside the application) or that is not a source file is left out.
        expect(
            sanitizeStack(
                withStack(new Error("x"), [
                    "    at fn (/home/alice/private.ts:1:1)",
                    "    at fn (/srv/app/src/ts/private.ts:1:1)",
                    "    at fn (/srv/app/server/src/../private/leak.ts:1:1)",
                    "    at fn (/srv/app/server/src/x.ts.bak:1:1)",
                    "    at fn (/srv/app/server/src/x.ts:1)",
                ]),
                appPath,
            ),
        ).toEqual([]);
        // The mapper's answer is checked again: a mapper that lets a traversal through is not trusted.
        expect(
            sanitizeStack(
                withStack(new Error("x"), ["    at fn (/srv/app/server/src/x.ts:1:1)"]),
                () => "server/src/../x.ts",
            ),
        ).toEqual([]);
    });

    it("stops at the frame limit and at the first line that is not a frame", () => {
        const frames = Array.from({ length: 12 }, (_, i) => `    at fn (/srv/app/server/src/f${i}.ts:${i + 1}:1)`);
        expect(sanitizeStack(withStack(new Error("x"), frames), appPath)).toHaveLength(MAX_STACK_FRAMES);
        expect(
            sanitizeStack(
                withStack(new Error("x"), [
                    "    at fn (/srv/app/server/src/a.ts:1:1)",
                    "Caused by: Error: the secret cause at /srv/app/server/src/b.ts:2:2",
                    "    at fn (/srv/app/server/src/c.ts:3:3)",
                ]),
                appPath,
            ),
        ).toEqual(["server/src/a.ts:1:1"]);
    });

    it("reads nothing unless the header is exactly the error's current name and message, so a message never becomes a frame", () => {
        // A message that holds a frame-like line is part of the header, not a frame.
        const framed = new Error("x\n    at evil (/srv/app/server/src/evil.ts:9:9)");
        framed.stack = `${framed.name}: ${framed.message}\n    at fn (/srv/app/server/src/real.ts:1:1)`;
        expect(sanitizeStack(framed, appPath)).toEqual(["server/src/real.ts:1:1"]);
        // A header that differs from the error's own (the message or name changed after the capture).
        const renamed = withStack(new Error("x"), ["    at fn (/srv/app/server/src/a.ts:1:1)"]);
        renamed.message = "y";
        expect(sanitizeStack(renamed, appPath)).toEqual([]);
        expect(
            sanitizeStack(
                withStack(new Error("x"), ["    at fn (/srv/app/server/src/a.ts:1:1)"], "Error: x "),
                appPath,
            ),
        ).toEqual([]);
        // An empty message: the header is the bare name.
        expect(sanitizeStack(withStack(new Error(""), ["    at fn (/srv/app/server/src/a.ts:1:1)"]), appPath)).toEqual([
            "server/src/a.ts:1:1",
        ]);
        expect(
            sanitizeStack(withStack(new Error(""), ["    at fn (/srv/app/server/src/a.ts:1:1)"], "Error: "), appPath),
        ).toEqual([]);
        // No stack, a non-string stack, a non-error.
        const bare = new Error("x");
        bare.stack = undefined;
        expect(sanitizeStack(bare, appPath)).toEqual([]);
        const odd = new Error("x");
        (odd as { stack: unknown }).stack = 42;
        expect(sanitizeStack(odd, appPath)).toEqual([]);
        expect(sanitizeStack("Error: x\n    at fn (/srv/app/server/src/a.ts:1:1)", appPath)).toEqual([]);
        expect(sanitizeStack({ stack: "Error: x\n    at fn (/srv/app/server/src/a.ts:1:1)" }, appPath)).toEqual([]);
    });
});

describe("errorName, diagnosticModel, and the error-event predicates", () => {
    it("names only a known error class of any object with that `name` (an Error, a DOMException, a plain object); a free-text or throwing name or a thrown primitive is `?`", () => {
        expect(errorName(new TypeError("x"))).toBe("TypeError");
        const custom = new Error("x");
        custom.name = "GenerationRunnerError";
        expect(errorName(custom)).toBe("GenerationRunnerError");
        custom.name = "AliceError";
        expect(errorName(custom)).toBe("?");
        expect(errorName("TypeError")).toBe("?");
        expect(errorName({ name: "TypeError" })).toBe("TypeError");
        expect(errorName({ name: "Alice's TypeError" })).toBe("?");
        expect(errorName({ name: 42 })).toBe("?");
        expect(errorName(Object.create(null))).toBe("?");
        expect(
            errorName({
                get name(): string {
                    throw new Error("no");
                },
            }),
        ).toBe("?");
        expect(errorName(undefined)).toBe("?");
        expect(errorName(null)).toBe("?");
        for (const name of [
            "AbortError",
            "TimeoutError",
            "NetworkError",
            "QuotaExceededError",
            "SecurityError",
            "DataCloneError",
        ]) {
            expect(errorName(new DOMException("x", name)), name).toBe(name);
        }
        expect(errorName(new DOMException("x", "WrongDocumentError"))).toBe("?");
    });

    it("maps a same-origin path to its template, literal templates first, `:x` one segment, a trailing `*` the rest, `?` for none; `isApiPath` names what the browser records", () => {
        const cases: [string, string][] = [
            ["/api/resources/revisions", "/api/resources/revisions"],
            ["/api/resources/read", "/api/resources/read"],
            ["/api/resources/characters", "/api/resources/:kind"],
            ["/api/resources/characters/alice", "/api/resources/:kind/:id"],
            ["/api/resources/characters/alice/more", "/api/resources/*"],
            ["/api/resources/", "/api/resources/*"],
            ["/api/resources", "/api/resources"],
            ["/api/generations", "/api/generations"],
            ["/api/generations/alice-job", "/api/generations/:id"],
            ["/api/generations/alice-job/ws", "/api/generations/*"],
            ["/api/llm/request/r1/answer", "/api/llm/request/:id/answer"],
            ["/api/llm/request", "/api/llm/request"],
            ["/api/llm-secrets/credentials/alice", "/api/llm-secrets/*"],
            ["/api/llm-secrets", "?"],
            ["/api/backups/b1/restore", "/api/backups/:id/restore"],
            ["/api/backups/b1", "?"],
            ["/api/request-history/r1", "/api/request-history/:id"],
            ["/api/diagnostics", "/api/diagnostics"],
            ["/api/diagnostics/", "?"],
            ["/api/nope", "?"],
            ["/api/nope/alice", "?"],
            ["/sw/init", "/sw/init"],
            ["/sw/check/616c696365", "/sw/check/*"],
            ["/sw/img/a/b", "/sw/img/*"],
            ["/sw/register/x", "/sw/register/*"],
            ["/sw/share/x", "/sw/share/*"],
            ["/sw/other", "?"],
            ["/hub-proxy/alice/card", "/hub-proxy/*"],
            ["/hub-proxy/", "/hub-proxy/*"],
            ["/proxy", "/proxy"],
            ["/proxy2", "/proxy2"],
            ["/", "/"],
            ["/index.html", "/index.html"],
            ["/assets/index-BZ0RKwIv.js", "?"],
            ["/Alice/private-chat", "?"],
            ["", "?"],
        ];
        for (const [pathname, template] of cases) {
            expect(apiRouteTemplate(pathname), pathname).toBe(template);
        }
        // The answer is always a member of the table, never the path.
        for (const [pathname] of cases) {
            expect(ROUTE_TEMPLATES).toContain(apiRouteTemplate(pathname));
        }
        for (const pathname of ["/api/list", "/api/", "/sw/init", "/hub-proxy/x", "/proxy", "/proxy2"]) {
            expect(isApiPath(pathname), pathname).toBe(true);
        }
        for (const pathname of [
            "/",
            "/api",
            "/apix/list",
            "/proxy3",
            "/proxy/",
            "/assets/x.js",
            "/sw.js",
            "/sw",
            "api/list",
            "/hub-proxy",
        ]) {
            expect(isApiPath(pathname), pathname).toBe(false);
        }
    });

    it("names a model by its catalog id, any other model `custom`, and no model as null", () => {
        expect(diagnosticModel(CATALOG_MODEL)).toBe(CATALOG_MODEL);
        expect(diagnosticModel("alice/private-model")).toBe(CUSTOM_MODEL);
        expect(diagnosticModel(`${CATALOG_MODEL} `)).toBe(CUSTOM_MODEL);
        expect(diagnosticModel("")).toBeNull();
        expect(diagnosticModel(null)).toBeNull();
        expect(diagnosticModel(undefined)).toBeNull();
    });

    it("counts as a failure a job error other than the owner's abort, and as an error event a runtime fault, a failed request, or a 5xx answer", () => {
        const event = (fields: Record<string, unknown>) =>
            projectDiagnosticEvent({ at: AT, ...fields }) as DiagnosticEvent;
        expect(isJobFailureEvent(event({ kind: "job", phase: "error", reason: "failed" }))).toBe(true);
        expect(isJobFailureEvent(event({ kind: "job", phase: "error", reason: "timeout" }))).toBe(true);
        expect(isJobFailureEvent(event({ kind: "job", phase: "error" }))).toBe(true);
        expect(isJobFailureEvent(event({ kind: "job", phase: "error", reason: "aborted" }))).toBe(false);
        expect(isJobFailureEvent(event({ kind: "job", phase: "done" }))).toBe(false);
        expect(isJobFailureEvent(event({ kind: "runtime", origin: "dispose" }))).toBe(false);

        expect(isDiagnosticErrorEvent(event({ kind: "job", phase: "error", reason: "shutdown" }))).toBe(true);
        expect(isDiagnosticErrorEvent(event({ kind: "job", phase: "error", reason: "aborted" }))).toBe(false);
        expect(isDiagnosticErrorEvent(event({ kind: "job", phase: "accepted" }))).toBe(false);
        expect(isDiagnosticErrorEvent(event({ kind: "runtime" }))).toBe(true);
        expect(isDiagnosticErrorEvent(event({ kind: "request", status: "error" }))).toBe(true);
        expect(isDiagnosticErrorEvent(event({ kind: "request", status: "aborted" }))).toBe(false);
        expect(isDiagnosticErrorEvent(event({ kind: "request" }))).toBe(false);
        expect(isDiagnosticErrorEvent(event({ kind: "http", status: 500 }))).toBe(true);
        expect(isDiagnosticErrorEvent(event({ kind: "http", status: 499 }))).toBe(false);
        expect(isDiagnosticErrorEvent(event({ kind: "http" }))).toBe(false);
        expect(isDiagnosticErrorEvent(event({ kind: "lifecycle", phase: "shutdown" }))).toBe(false);
    });
});
