import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticEvent } from "../../../shared/diagnostics.ts";

// Request history slice 8 (`docs/plan/request-history-diagnostics.md`): the browser's diagnostics
// collector (`collector.ts`). The client projection (only the browser's kinds, a UUID job id, a
// route from the table, no server-only field) when recording and when restoring; the 300-event
// ring and the folding of a repeated event; the `sessionStorage` mirror (a bounded flush, the
// synchronous flushes, the writer cut to what the restore reads, every storage failure survived);
// the `window.fetch` wrapper (the original first with the same arguments, the same response and
// rejection, an unhandled rejection still unhandled, bodies untouched, only same-origin API
// failures as content-free events, aborts skipped, timeouts named); the window's error and
// rejection listeners; and the browser stack formats (V8, Gecko, WebKit) against this origin.

type Collector = typeof import("./collector");

const ORIGIN = "http://localhost:3000";
const JOB = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
const AT = 1_700_000_000_000;

let collector: Collector;
let originalFetch: typeof fetch;
let storageDescriptor: PropertyDescriptor | undefined;

beforeEach(async () => {
    vi.resetModules();
    sessionStorage.clear();
    originalFetch = globalThis.fetch;
    storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    collector = await import("./collector");
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (storageDescriptor) {
        Object.defineProperty(globalThis, "sessionStorage", storageDescriptor);
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

/** The ring without the times (`at`, `lastAt`) and durations, for exact comparisons. */
const projected = (events: DiagnosticEvent[]) =>
    events.map(({ at, lastAt, durationMs, ...rest }) => rest as Record<string, unknown>);
const ofKind = (kind: string) => collector.clientDiagnosticEvents().filter((event) => event.kind === kind);
const stored = () => JSON.parse(sessionStorage.getItem("risu-diagnostics") ?? "null") as DiagnosticEvent[] | null;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** An `Error` whose stack is exactly `stack`. */
function withStack(error: Error, stack: string): Error {
    error.stack = stack;
    return error;
}
/** A V8 stack of `error` with these frame lines after the exact header. */
function v8(error: Error, frames: string[]): Error {
    const header = error.message ? `${error.name}: ${error.message}` : error.name;
    return withStack(error, [header, ...frames].join("\n"));
}
/** Dispatches a window `error` or `unhandledrejection` event carrying `value`, as the browser would. */
function dispatch(type: "error" | "unhandledrejection", value: unknown): Event {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, type === "error" ? "error" : "reason", { value });
    window.dispatchEvent(event);
    return event;
}
function setVisibility(state: "hidden" | "visible") {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
}

describe("projectClientEvent", () => {
    it("keeps only the browser's kinds, the window's runtime origins, and no server-only field", () => {
        const { projectClientEvent } = collector;
        for (const kind of ["job", "request", "lifecycle"]) {
            expect(projectClientEvent({ at: AT, kind, phase: "boot", jobId: JOB }), kind).toBeNull();
        }
        expect(projectClientEvent({ at: AT, kind: "script" })).toBeNull();
        expect(projectClientEvent(null)).toBeNull();
        expect(projectClientEvent({ kind: "page", phase: "boot" })).toBeNull();
        for (const kind of ["http", "runtime", "jobLink", "feed", "sync", "serviceWorker", "page"]) {
            const event = projectClientEvent({ at: AT, kind, ...(kind === "runtime" ? { origin: "error" } : {}) });
            expect(event?.kind, kind).toBe(kind);
        }
        // The server's runtime origins are not the tab's; a runtime `jobId` is the server's field.
        for (const origin of ["uncaughtException", "unhandledRejection", "serverError", "generation.release"]) {
            expect(projectClientEvent({ at: AT, kind: "runtime", origin }), origin).toBeNull();
        }
        expect(projectClientEvent({ at: AT, kind: "runtime" })).toBeNull();
        expect(projectClientEvent({ at: 1, kind: "runtime", origin: "error", jobId: "Alice" })).toEqual({
            at: 1,
            kind: "runtime",
            origin: "error",
        });
        expect(projectClientEvent({ at: 1, kind: "runtime", origin: "error", jobId: JOB })).toEqual({
            at: 1,
            kind: "runtime",
            origin: "error",
        });
        expect(
            projectClientEvent({
                at: AT,
                kind: "runtime",
                origin: "unhandledrejection",
                name: "QuotaExceededError",
                stack: ["src/ts/x.ts:1:2"],
                message: "secret",
            }),
        ).toEqual({
            at: AT,
            kind: "runtime",
            origin: "unhandledrejection",
            name: "QuotaExceededError",
            stack: ["src/ts/x.ts:1:2"],
        });
    });

    it("jobLink: a lowercase UUID job id only, the phase, the attempt, a close code, and `terminal`", () => {
        const { projectClientEvent } = collector;
        const full = { at: AT, kind: "jobLink", phase: "detach", jobId: JOB, attempt: 2, code: 1006, terminal: false };
        expect(projectClientEvent(full)).toEqual(full);
        for (const jobId of ["Alice", "alice-private-chat", JOB.toUpperCase(), `${JOB}x`, "j1", 42, ""]) {
            expect(projectClientEvent({ at: AT, kind: "jobLink", jobId }), String(jobId)).toEqual({
                at: AT,
                kind: "jobLink",
            });
        }
        expect(
            projectClientEvent({
                at: AT,
                kind: "jobLink",
                phase: "opened",
                attempt: -1,
                code: 999,
                terminal: "yes",
                reason: "closed by Alice",
                url: "wss://x/api/generations/alice/ws",
            }),
        ).toEqual({ at: AT, kind: "jobLink" });
        expect(projectClientEvent({ at: AT, kind: "jobLink", code: 5000 })).toEqual({ at: AT, kind: "jobLink" });
        expect(projectClientEvent({ at: AT, kind: "jobLink", code: 4999 })).toHaveProperty("code", 4999);
    });

    it("feed, sync, serviceWorker, page: the phases by their lists, counts as non-negative integers, nothing else", () => {
        const { projectClientEvent } = collector;
        const feed = { at: AT, kind: "feed", phase: "connectFailed", attempt: 3, code: 1001 };
        expect(projectClientEvent(feed)).toEqual(feed);
        expect(
            projectClientEvent({ at: AT, kind: "feed", phase: "hello", attempt: 1.5, code: "1006", url: "wss://x" }),
        ).toEqual({ at: AT, kind: "feed" });
        const sync = { at: AT, kind: "sync", phase: "conflict", records: 1, chats: 2, orders: 0, generating: 1 };
        expect(projectClientEvent(sync)).toEqual(sync);
        expect(projectClientEvent({ at: AT, kind: "sync", phase: "reload", reason: "restore" })).toEqual({
            at: AT,
            kind: "sync",
            phase: "reload",
            reason: "restore",
        });
        expect(
            projectClientEvent({
                at: AT,
                kind: "sync",
                phase: "halt",
                reason: "Alice",
                records: -1,
                generating: true,
                ids: ["a"],
            }),
        ).toEqual({ at: AT, kind: "sync" });
        for (const phase of ["registered", "registerFailed", "initFailed", "unsupported", "controllerChange"]) {
            expect(projectClientEvent({ at: AT, kind: "serviceWorker", phase })).toEqual({
                at: AT,
                kind: "serviceWorker",
                phase,
            });
        }
        expect(projectClientEvent({ at: AT, kind: "serviceWorker", phase: "updated", scope: "/" })).toEqual({
            at: AT,
            kind: "serviceWorker",
        });
        for (const phase of ["boot", "visible", "hidden", "online", "offline"]) {
            expect(projectClientEvent({ at: AT, kind: "page", phase })).toEqual({ at: AT, kind: "page", phase });
        }
        expect(projectClientEvent({ at: AT, kind: "page", phase: "unload", url: "/x" })).toEqual({
            at: AT,
            kind: "page",
        });
    });

    it("http: a route from the table only (never a path), a status or a failure, and the folding fields `repeat` and `lastAt`", () => {
        const { projectClientEvent } = collector;
        const full = {
            at: AT,
            kind: "http",
            method: "POST",
            route: "/api/resources/:kind/:id",
            status: 409,
            durationMs: 5,
            repeat: 3,
            lastAt: AT + 10,
        };
        expect(projectClientEvent(full)).toEqual(full);
        expect(projectClientEvent({ at: AT, kind: "http", route: "?", failure: "timeout" })).toEqual({
            at: AT,
            kind: "http",
            route: "?",
            failure: "timeout",
        });
        for (const route of [
            "/Alice/private-chat",
            "/api/resources/characters/alice",
            "/api/generations/:id/ws",
            "*",
            "",
            1,
        ]) {
            expect(projectClientEvent({ at: AT, kind: "http", route }), String(route)).toEqual({
                at: AT,
                kind: "http",
            });
        }
        expect(projectClientEvent({ at: AT, kind: "http", failure: "network", repeat: 0.5, lastAt: -1 })).toEqual({
            at: AT,
            kind: "http",
        });
    });
});

describe("the ring", () => {
    it("records a projected event before the collector starts, drops what the projection refuses, and never throws", () => {
        collector.recordClientEvent({ kind: "page", phase: "online", url: "/private" });
        collector.recordClientEvent({ kind: "lifecycle", phase: "boot" });
        collector.recordClientEvent({ kind: "job", phase: "accepted", jobId: JOB });
        collector.recordClientEvent({ kind: "nope" as never });
        collector.recordClientEvent({ kind: "jobLink", phase: "attach", jobId: "Alice" });
        expect(() => collector.recordClientEvent(null as never)).not.toThrow();
        expect(() =>
            collector.recordClientEvent({
                kind: "http",
                get method(): string {
                    throw new Error("x");
                },
            }),
        ).not.toThrow();
        expect(projected(collector.clientDiagnosticEvents())).toEqual([
            { kind: "page", phase: "online" },
            { kind: "jobLink", phase: "attach" },
        ]);
    });

    it("keeps the newest 300 events, oldest first, and hands out copies (a stack included)", () => {
        for (let i = 0; i < 310; i++) {
            collector.recordClientEvent({ kind: "http", method: "GET", route: "?", status: 100 + i });
        }
        const events = collector.clientDiagnosticEvents();
        expect(events).toHaveLength(300);
        expect(events[0].status).toBe(110);
        expect(events[299].status).toBe(409);
        collector.recordClientEvent({
            kind: "runtime",
            origin: "error",
            name: "TypeError",
            stack: ["src/ts/x.ts:1:2"],
        });
        const copy = collector.clientDiagnosticEvents().at(-1)!;
        (copy.stack as string[]).push("src/ts/forged.ts:1:1");
        copy.name = "Alice";
        const again = collector.clientDiagnosticEvents().at(-1)!;
        expect(again.stack).toEqual(["src/ts/x.ts:1:2"]);
        expect(again.name).toBe("TypeError");
    });

    it("folds an event identical to one of the last 16 (but for its times and duration) within 10 minutes into it: `repeat`, `lastAt`, the first `at` kept", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.setSystemTime(AT);
        collector.recordClientEvent({ kind: "http", method: "GET", route: "/api/list", status: 500, durationMs: 10 });
        vi.setSystemTime(AT + 1000);
        collector.recordClientEvent({ kind: "page", phase: "online" });
        vi.setSystemTime(AT + 2000);
        collector.recordClientEvent({ kind: "http", method: "GET", route: "/api/list", status: 500, durationMs: 900 });
        expect(collector.clientDiagnosticEvents()).toEqual([
            {
                at: AT,
                kind: "http",
                method: "GET",
                route: "/api/list",
                status: 500,
                durationMs: 10,
                repeat: 2,
                lastAt: AT + 2000,
            },
            { at: AT + 1000, kind: "page", phase: "online" },
        ]);
        // A field that differs (the status, a frame) is another event.
        collector.recordClientEvent({ kind: "http", method: "GET", route: "/api/list", status: 502 });
        expect(collector.clientDiagnosticEvents()).toHaveLength(3);
        // Past 10 minutes after the last occurrence it is recorded anew.
        vi.setSystemTime(AT + 2000 + 10 * 60_000 + 1);
        collector.recordClientEvent({ kind: "http", method: "GET", route: "/api/list", status: 500 });
        expect(collector.clientDiagnosticEvents()).toHaveLength(4);
        expect(collector.clientDiagnosticEvents()[0].repeat).toBe(2);
        // Within 10 minutes of that occurrence (not the first) it folds again.
        vi.setSystemTime(AT + 2000 + 20 * 60_000);
        collector.recordClientEvent({ kind: "http", method: "GET", route: "/api/list", status: 500 });
        expect(collector.clientDiagnosticEvents()).toHaveLength(4);
        expect(collector.clientDiagnosticEvents()[3]).toMatchObject({ repeat: 2, lastAt: AT + 2000 + 20 * 60_000 });
    });

    it("looks back 16 events only, never folds a page boot, and keeps a retry loop (a 409 and its conflict every 5 s) to two entries", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.setSystemTime(AT);
        collector.recordClientEvent({ kind: "page", phase: "offline" });
        for (let i = 0; i < 16; i++) {
            collector.recordClientEvent({ kind: "http", method: "GET", route: "?", status: 400 + i });
        }
        collector.recordClientEvent({ kind: "page", phase: "offline" });
        expect(collector.clientDiagnosticEvents()).toHaveLength(18);
        expect(collector.clientDiagnosticEvents()[0].repeat).toBeUndefined();
        collector.startDiagnosticsCollector();
        collector.recordClientEvent({ kind: "page", phase: "boot" });
        expect(ofKind("page").filter((event) => event.phase === "boot")).toHaveLength(2);
        for (let i = 0; i < 160; i++) {
            vi.setSystemTime(AT + i * 5000);
            collector.recordClientEvent({
                kind: "http",
                method: "POST",
                route: "/api/resources/batch",
                status: 409,
                durationMs: i,
            });
            collector.recordClientEvent({
                kind: "sync",
                phase: "conflict",
                records: 0,
                chats: 1,
                orders: 0,
                generating: 1,
            });
        }
        const events = collector.clientDiagnosticEvents();
        expect(events).toHaveLength(22);
        expect(events.at(-2)).toMatchObject({ kind: "http", status: 409, repeat: 160, lastAt: AT + 159 * 5000 });
        expect(events.at(-1)).toMatchObject({ kind: "sync", phase: "conflict", repeat: 160 });
        expect(events[0]).toMatchObject({ kind: "page", phase: "offline" });
    });
});

describe("the sessionStorage mirror", () => {
    it("writes the ring at most a second after the first pending event, not postponed by later ones, and at once on a flush", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.setSystemTime(AT);
        collector.recordClientEvent({ kind: "page", phase: "online" });
        expect(stored()).toBeNull();
        vi.advanceTimersByTime(600);
        collector.recordClientEvent({ kind: "page", phase: "offline" });
        vi.advanceTimersByTime(399);
        expect(stored()).toBeNull();
        vi.advanceTimersByTime(1);
        expect(projected(stored()!)).toEqual([
            { kind: "page", phase: "online" },
            { kind: "page", phase: "offline" },
        ]);
        collector.recordClientEvent({ kind: "feed", phase: "connected", attempt: 0 });
        collector.flushClientDiagnostics();
        expect(stored()).toHaveLength(3);
        // The flush cleared the pending timer: nothing else is written later.
        sessionStorage.clear();
        vi.advanceTimersByTime(5000);
        expect(stored()).toBeNull();
    });

    it("records `hidden` and flushes when the page is hidden, flushes on pagehide, and records `visible`, `online`, and `offline`", () => {
        collector.startDiagnosticsCollector();
        setVisibility("hidden");
        expect(projected(stored()!)).toEqual([
            { kind: "page", phase: "boot" },
            { kind: "page", phase: "hidden" },
        ]);
        setVisibility("visible");
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("online"));
        expect(projected(ofKind("page"))).toEqual([
            { kind: "page", phase: "boot" },
            { kind: "page", phase: "hidden" },
            { kind: "page", phase: "visible" },
            { kind: "page", phase: "offline" },
            { kind: "page", phase: "online" },
        ]);
        expect(stored()).toHaveLength(2);
        window.dispatchEvent(new Event("pagehide"));
        expect(stored()).toHaveLength(5);
    });

    it("restores the stored ring before this page's events, each entry projected again (a hostile entry dropped), the newest 300 kept", async () => {
        const entries: unknown[] = [
            { at: AT, kind: "feed", phase: "disconnected", attempt: 1, code: 1006, repeat: 4, lastAt: AT + 5 },
            { at: AT + 1, kind: "job", phase: "accepted", jobId: JOB },
            {
                at: AT + 2,
                kind: "runtime",
                origin: "error",
                jobId: "Alice",
                name: "TypeError",
                stack: ["src/ts/x.ts:1:2"],
            },
            { at: AT + 3, kind: "runtime", origin: "uncaughtException", name: "TypeError" },
            { at: AT + 4, kind: "http", method: "GET", route: "/Alice/private-chat", status: 404 },
            { at: AT + 5, kind: "jobLink", phase: "attach", jobId: "alice" },
            { at: AT + 6, kind: "page", phase: "hidden", url: "https://x/private" },
            "a string",
            null,
            42,
            { kind: "page", phase: "boot" },
        ];
        for (let i = 0; i < 310; i++) {
            entries.push({ at: AT + 100 + i, kind: "http", method: "GET", route: "?", status: 100 + i });
        }
        sessionStorage.setItem("risu-diagnostics", JSON.stringify(entries));
        collector.recordClientEvent({ kind: "page", phase: "online" });
        collector.startDiagnosticsCollector();
        const events = collector.clientDiagnosticEvents();
        expect(events).toHaveLength(300);
        // The newest 300 of the stored entries are the last 300 http ones; then this page's.
        expect(events[0]).toEqual({ at: AT + 100 + 12, kind: "http", method: "GET", route: "?", status: 112 });
        expect(events.at(-2)).toEqual({ at: expect.any(Number), kind: "page", phase: "online" });
        expect(events.at(-1)).toEqual({ at: expect.any(Number), kind: "page", phase: "boot" });
        expect(JSON.stringify(events)).not.toMatch(/Alice|alice|private/);

        // Without the overflow, the hostile entries are dropped on their own and the fields re-projected.
        vi.resetModules();
        sessionStorage.setItem("risu-diagnostics", JSON.stringify(entries.slice(0, 11)));
        const fresh: Collector = await import("./collector");
        fresh.startDiagnosticsCollector();
        expect(fresh.clientDiagnosticEvents()).toEqual([
            { at: AT, kind: "feed", phase: "disconnected", attempt: 1, code: 1006, repeat: 4, lastAt: AT + 5 },
            { at: AT + 2, kind: "runtime", origin: "error", name: "TypeError", stack: ["src/ts/x.ts:1:2"] },
            { at: AT + 4, kind: "http", method: "GET", status: 404 },
            { at: AT + 5, kind: "jobLink", phase: "attach" },
            { at: AT + 6, kind: "page", phase: "hidden" },
            { at: expect.any(Number), kind: "page", phase: "boot" },
        ]);
    });

    it("reads nothing from a stored value that is too large, not JSON, or not an array, and the ring still works", async () => {
        for (const raw of [`[${"1,".repeat(300_000)}1]`, "{", '{"at":1,"kind":"page","phase":"boot"}', "null", "42"]) {
            vi.resetModules();
            sessionStorage.setItem("risu-diagnostics", raw);
            const fresh: Collector = await import("./collector");
            fresh.startDiagnosticsCollector();
            expect(projected(fresh.clientDiagnosticEvents()), raw.slice(0, 20)).toEqual([
                { kind: "page", phase: "boot" },
            ]);
        }
    });

    it("survives a storage that throws on read, on write, or at access, and one that is missing", async () => {
        const broken = {
            getItem() {
                throw new DOMException("denied", "SecurityError");
            },
            setItem() {
                throw new DOMException("full", "QuotaExceededError");
            },
        };
        vi.stubGlobal("sessionStorage", broken);
        collector.startDiagnosticsCollector();
        collector.recordClientEvent({ kind: "page", phase: "online" });
        expect(() => collector.flushClientDiagnostics()).not.toThrow();
        window.dispatchEvent(new Event("pagehide"));
        expect(projected(collector.clientDiagnosticEvents())).toEqual([
            { kind: "page", phase: "boot" },
            { kind: "page", phase: "online" },
        ]);

        vi.resetModules();
        Object.defineProperty(globalThis, "sessionStorage", {
            configurable: true,
            get() {
                throw new DOMException("denied", "SecurityError");
            },
        });
        const second: Collector = await import("./collector");
        expect(() => second.startDiagnosticsCollector()).not.toThrow();
        second.recordClientEvent({ kind: "page", phase: "offline" });
        expect(() => second.flushClientDiagnostics()).not.toThrow();
        expect(projected(second.clientDiagnosticEvents())).toEqual([
            { kind: "page", phase: "boot" },
            { kind: "page", phase: "offline" },
        ]);

        vi.resetModules();
        Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: undefined });
        const third: Collector = await import("./collector");
        expect(() => third.startDiagnosticsCollector()).not.toThrow();
        expect(() => third.flushClientDiagnostics()).not.toThrow();
        expect(third.clientDiagnosticEvents()).toHaveLength(1);
    });

    it("leaves the oldest events out of the mirror until it fits what the restore reads, so a fresh page restores the newest", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.setSystemTime(AT);
        const frame = (i: number, j: number) => `src/${"a".repeat(200)}.ts:${1000000 + i}:${1000000 + j}`;
        for (let i = 0; i < 300; i++) {
            collector.recordClientEvent({
                kind: "runtime",
                origin: "error",
                name: "TypeError",
                stack: Array.from({ length: 8 }, (_, j) => frame(i, j)),
            });
        }
        expect(JSON.stringify(collector.clientDiagnosticEvents()).length).toBeGreaterThan(512 * 1024);
        collector.flushClientDiagnostics();
        const raw = sessionStorage.getItem("risu-diagnostics")!;
        expect(raw.length).toBeLessThanOrEqual(512 * 1024);
        const kept = JSON.parse(raw) as DiagnosticEvent[];
        expect(kept.length).toBeGreaterThan(200);
        expect(kept.length).toBeLessThan(300);
        expect(kept.at(-1)!.stack).toEqual(collector.clientDiagnosticEvents().at(-1)!.stack);

        vi.resetModules();
        const fresh: Collector = await import("./collector");
        fresh.startDiagnosticsCollector();
        expect(fresh.clientDiagnosticEvents()).toHaveLength(kept.length + 1);
        expect(fresh.clientDiagnosticEvents()[0]).toEqual(kept[0]);
    });
});

describe("the fetch wrapper", () => {
    /** Installs `answer` as the page's fetch and starts the collector over it. */
    function install(answer: (...args: Parameters<typeof fetch>) => Promise<Response>) {
        const original = vi.fn(answer);
        vi.stubGlobal("fetch", original);
        collector.startDiagnosticsCollector();
        return original;
    }

    it("calls the original once, first, with the same receiver and arguments, and resolves with the same response; a success is no event", async () => {
        const response = new Response("ok", { status: 200 });
        const original = install(async () => response);
        expect(window.fetch).not.toBe(original);
        const init = { method: "POST", keepalive: true, body: "x", headers: { "content-type": "text/plain" } };
        const answered = await window.fetch("/api/resources/batch", init);
        expect(answered).toBe(response);
        expect(original).toHaveBeenCalledTimes(1);
        expect(original.mock.calls[0][0]).toBe("/api/resources/batch");
        expect(original.mock.calls[0][1]).toBe(init);
        expect(original.mock.contexts[0]).toBe(window);
        // A bare call (no receiver) is dispatched on the window too.
        const bare = window.fetch;
        await bare("/api/list");
        expect(original.mock.contexts[1]).toBe(window);
        expect(ofKind("http")).toEqual([]);
        // A `Request` is handed over as is.
        const request = new Request(`${ORIGIN}/api/list`);
        await window.fetch(request);
        expect(original.mock.calls[2][0]).toBe(request);
    });

    it("records a same-origin API answer of 400 or more as the method, the route template, the status, and the duration, never the URL", async () => {
        install(async (input) => new Response("no", { status: String(input).includes("characters") ? 404 : 500 }));
        await window.fetch("/api/resources/characters/alice?secret=1");
        await window.fetch(new URL("/api/generations/alice-job/ws", location.href), { method: "delete" });
        await window.fetch(new Request(`${ORIGIN}/api/resources/revisions`, { method: "POST" }), { method: "put" });
        await window.fetch("api/nope/alice");
        await window.fetch("/sw/check/616c696365");
        await window.fetch("/hub-proxy/alice", { method: "GET" });
        await window.fetch("/proxy2");
        await window.fetch({ url: "/api/list", method: "DELETE" } as unknown as Request);
        const events = ofKind("http");
        expect(projected(events)).toEqual([
            { kind: "http", method: "GET", route: "/api/resources/:kind/:id", status: 404 },
            { kind: "http", method: "DELETE", route: "/api/generations/*", status: 500 },
            { kind: "http", method: "PUT", route: "/api/resources/revisions", status: 500 },
            { kind: "http", method: "GET", route: "?", status: 500 },
            { kind: "http", method: "GET", route: "/sw/check/*", status: 500 },
            { kind: "http", method: "GET", route: "/hub-proxy/*", status: 500 },
            { kind: "http", method: "GET", route: "/proxy2", status: 500 },
            { kind: "http", method: "DELETE", route: "/api/list", status: 500 },
        ]);
        for (const event of events) {
            expect(event.durationMs).toBeGreaterThanOrEqual(0);
        }
        expect(JSON.stringify(events)).not.toMatch(/alice|secret|localhost|616c/);
    });

    it("ignores a fetch that is not a same-origin API one, returning the original's own promise", async () => {
        const promises: Promise<Response>[] = [];
        const original = install(() => {
            const promise = Promise.resolve(new Response("x", { status: 500 }));
            promises.push(promise);
            return promise;
        });
        const urls = [
            "/assets/index-BZ0RKwIv.js",
            "/",
            "/index.html",
            "/sw.js",
            "/apix/list",
            `${ORIGIN}/api2/list`,
            "https://example.com/api/list",
            "https://example.com/",
            "http://localhost:3001/api/list",
            "data:text/plain,hi",
        ];
        for (const [i, url] of urls.entries()) {
            expect(window.fetch(url), url).toBe(promises[i]);
        }
        // A `Request`-like without a readable URL, and a method the table does not know, are no event either.
        await window.fetch({} as Request);
        await window.fetch(new URL("/api/list", location.href), { method: "PROPFIND" });
        expect(original).toHaveBeenCalledTimes(urls.length + 2);
        expect(ofKind("http")).toEqual([
            { at: expect.any(Number), kind: "http", route: "/api/list", status: 500, durationMs: expect.any(Number) },
        ]);
    });

    it("reads the request's metadata after the dispatch, each property once, and a throwing accessor changes nothing", async () => {
        const original = install(async () => new Response("x", { status: 500 }));
        let reads = 0;
        let dispatchedAtRead = -1;
        const init: RequestInit = {
            get method() {
                reads += 1;
                dispatchedAtRead = original.mock.calls.length;
                return reads === 1 ? "GET" : "POST";
            },
        };
        await window.fetch("/api/list", init);
        expect(reads).toBe(1);
        expect(dispatchedAtRead).toBe(1);
        expect(original.mock.calls[0][1]).toBe(init);
        expect(projected(ofKind("http"))).toEqual([{ kind: "http", method: "GET", route: "/api/list", status: 500 }]);

        const response = new Response("y", { status: 503 });
        original.mockResolvedValueOnce(response);
        const throwing = {
            get method(): string {
                throw new Error("no");
            },
        };
        await expect(window.fetch("/api/list", throwing)).resolves.toBe(response);
        expect(original.mock.calls[1][1]).toBe(throwing);
        expect(ofKind("http")).toHaveLength(1);
    });

    it("rejects with the same reason, records a rejection as `failure: rejected`, and leaves a rejection nobody handles unhandled", async () => {
        const reason = new TypeError("Failed to fetch");
        install(async () => {
            throw reason;
        });
        await expect(window.fetch("/api/list")).rejects.toBe(reason);
        expect(projected(ofKind("http"))).toEqual([
            { kind: "http", method: "GET", route: "/api/list", failure: "rejected" },
        ]);

        // The process's own listeners (the runner's) are set aside while the unhandled rejection is counted.
        const previous = process.listeners("unhandledRejection");
        for (const listener of previous) {
            process.off("unhandledRejection", listener);
        }
        const unhandled: unknown[] = [];
        const count = (value: unknown) => unhandled.push(value);
        process.on("unhandledRejection", count);
        try {
            void window.fetch("/api/list");
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
        } finally {
            process.off("unhandledRejection", count);
            for (const listener of previous) {
                process.on("unhandledRejection", listener);
            }
        }
        expect(unhandled).toEqual([reason]);
        expect(ofKind("http")).toHaveLength(1);
        expect(ofKind("http")[0].repeat).toBe(2);
    });

    it("skips an ordinary abort (the init's or the request's signal, any reason), and names a timeout", async () => {
        const abortError = () => new DOMException("The operation was aborted.", "AbortError");
        const original = install(async () => {
            throw abortError();
        });
        const aborted = new AbortController();
        aborted.abort();
        await expect(window.fetch("/api/list", { signal: aborted.signal })).rejects.toThrow("aborted");
        // A custom reason: the error is not an AbortError, but the signal says so.
        const custom = new AbortController();
        const why = new Error("why");
        custom.abort(why);
        original.mockRejectedValueOnce(why);
        await expect(window.fetch("/api/list", { signal: custom.signal })).rejects.toBe(why);
        // The request's own signal, with an init that does not override it (`signal: undefined`).
        const failed = new TypeError("Failed to fetch");
        original.mockRejectedValueOnce(failed);
        const request = new Request(`${ORIGIN}/api/list`, { signal: custom.signal });
        await expect(window.fetch(request, { signal: undefined })).rejects.toBe(failed);
        // An AbortError without any signal (the caller aborted through a `Request` of another realm).
        await expect(window.fetch({ url: "/api/list" } as Request)).rejects.toThrow("aborted");
        expect(ofKind("http")).toEqual([]);

        // `signal: null` overrides the request's signal: that rejection is a plain one.
        original.mockRejectedValueOnce(failed);
        await expect(window.fetch(request, { signal: null })).rejects.toBe(failed);
        expect(projected(ofKind("http"))).toEqual([
            { kind: "http", method: "GET", route: "/api/list", failure: "rejected" },
        ]);

        // A timeout: the rejection's name, or the aborted signal's reason.
        original.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
        await expect(window.fetch("/sw/init")).rejects.toThrow("timed out");
        const timeout = new AbortController();
        const timeoutReason = new DOMException("timed out", "TimeoutError");
        timeout.abort(timeoutReason);
        original.mockRejectedValueOnce(timeoutReason);
        await expect(window.fetch("/sw/register/616c", { method: "POST", signal: timeout.signal })).rejects.toBe(
            timeoutReason,
        );
        expect(projected(ofKind("http")).slice(1)).toEqual([
            { kind: "http", method: "GET", route: "/sw/init", failure: "timeout" },
            { kind: "http", method: "POST", route: "/sw/register/*", failure: "timeout" },
        ]);
    });

    it("never touches a body: a streamed answer is read by the caller alone, and the duration ends when the fetch settles", async () => {
        let pulled = 0;
        // No read-ahead (`highWaterMark: 0`): the stream is pulled only by a reader.
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    pulled += 1;
                    controller.enqueue(new TextEncoder().encode("chunk"));
                    controller.close();
                },
            },
            { highWaterMark: 0 },
        );
        const response = new Response(body, { status: 500 });
        install(async () => response);
        const answered = await window.fetch("/api/llm/request", { method: "POST", body: "prompt" });
        expect(answered).toBe(response);
        expect(pulled).toBe(0);
        expect(answered.bodyUsed).toBe(false);
        expect(ofKind("http")).toHaveLength(1);
        expect(await answered.text()).toBe("chunk");
    });

    it("starts once: a second start neither wraps the wrapper nor records another boot", async () => {
        const original = install(async () => new Response("x", { status: 500 }));
        const wrapped = window.fetch;
        collector.startDiagnosticsCollector();
        expect(window.fetch).toBe(wrapped);
        await window.fetch("/api/list");
        expect(original).toHaveBeenCalledTimes(1);
        expect(ofKind("page")).toHaveLength(1);
    });

    it("leaves the page's fetch alone when there is none to wrap", () => {
        vi.stubGlobal("fetch", undefined);
        expect(() => collector.startDiagnosticsCollector()).not.toThrow();
        expect(window.fetch).toBeUndefined();
    });
});

describe("the window's error and rejection listeners", () => {
    it("records an uncaught error as its name and application frames, never its message, beside the page's own handlers", () => {
        const seen: unknown[] = [];
        window.addEventListener("error", (event) => seen.push((event as ErrorEvent).error));
        collector.startDiagnosticsCollector();
        const error = v8(new TypeError("Alice's secret\n    at evil (http://localhost:3000/src/evil.ts:9:9)"), [
            "    at run (http://localhost:3000/src/ts/process/index.svelte.ts?t=1700000:12:34)",
            "    at http://localhost:3000/node_modules/.vite/deps/chunk-ABC.js?v=1:1:1",
            "    at async main (http://localhost:3000/assets/index-client-BZ0RKwIv.js:5:6)",
        ]);
        const event = dispatch("error", error);
        expect(event.defaultPrevented).toBe(false);
        expect(window.onerror).toBeNull();
        expect(seen).toEqual([error]);
        expect(projected(ofKind("runtime"))).toEqual([
            {
                kind: "runtime",
                origin: "error",
                name: "TypeError",
                stack: ["src/ts/process/index.svelte.ts:12:34", "assets/index-client-BZ0RKwIv.js:5:6"],
            },
        ]);
        expect(JSON.stringify(collector.clientDiagnosticEvents())).not.toMatch(
            /Alice|secret|evil|localhost|node_modules/,
        );
    });

    it("records an unhandled rejection: a DOMException by its name, a plain object by a listed name without frames, a primitive as `?`", () => {
        collector.startDiagnosticsCollector();
        dispatch("unhandledrejection", new DOMException("The quota has been exceeded.", "QuotaExceededError"));
        dispatch("unhandledrejection", {
            name: "TypeError",
            message: "secret",
            stack: "TypeError: secret\n    at run (http://localhost:3000/src/ts/private.ts:1:2)",
        });
        dispatch("unhandledrejection", "Alice's secret string");
        dispatch("unhandledrejection", undefined);
        const named = new Error("x");
        named.name = "AliceError";
        dispatch("unhandledrejection", named);
        dispatch("unhandledrejection", {
            get name(): string {
                throw new Error("no");
            },
        });
        expect(projected(ofKind("runtime"))).toEqual([
            { kind: "runtime", origin: "unhandledrejection", name: "QuotaExceededError", stack: [] },
            { kind: "runtime", origin: "unhandledrejection", name: "TypeError", stack: [] },
            { kind: "runtime", origin: "unhandledrejection", name: "?", stack: [], repeat: 4 },
        ]);
        expect(JSON.stringify(collector.clientDiagnosticEvents())).not.toMatch(/Alice|secret|private/);
    });

    it("records the service worker's controller change when the browser has one, and starts without it", async () => {
        const container = new EventTarget();
        Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
        try {
            collector.startDiagnosticsCollector();
            container.dispatchEvent(new Event("controllerchange"));
            expect(projected(ofKind("serviceWorker"))).toEqual([{ kind: "serviceWorker", phase: "controllerChange" }]);
        } finally {
            delete (navigator as { serviceWorker?: unknown }).serviceWorker;
        }
        vi.resetModules();
        Object.defineProperty(navigator, "serviceWorker", {
            configurable: true,
            get() {
                throw new DOMException("denied", "SecurityError");
            },
        });
        try {
            const fresh: Collector = await import("./collector");
            expect(() => fresh.startDiagnosticsCollector()).not.toThrow();
            expect(fresh.clientDiagnosticEvents()).toHaveLength(1);
        } finally {
            delete (navigator as { serviceWorker?: unknown }).serviceWorker;
        }
    });
});

describe("clientAppPath and browserStack", () => {
    it("maps a file of this origin under /src/, /shared/, or /assets/ to its path without the query, and anything else to null", () => {
        const { clientAppPath } = collector;
        expect(clientAppPath(`${ORIGIN}/src/ts/x.ts?t=1700000#frag`)).toBe("src/ts/x.ts");
        expect(clientAppPath(`${ORIGIN}/shared/cbs/parser.ts`)).toBe("shared/cbs/parser.ts");
        expect(clientAppPath(`${ORIGIN}/assets/index-BZ0RKwIv.js`)).toBe("assets/index-BZ0RKwIv.js");
        for (const file of [
            `${ORIGIN}/node_modules/.vite/deps/svelte.js`,
            `${ORIGIN}/@fs/home/alice/src/x.ts`,
            `${ORIGIN}/@vite/client`,
            `${ORIGIN}/sw.js`,
            `${ORIGIN}/srcx/x.ts`,
            `${ORIGIN}/src`,
            "https://evil.example/src/ts/x.ts",
            "http://localhost:3001/src/ts/x.ts",
            "blob:http://localhost:3000/0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c",
            "data:text/javascript,alert(1)",
            "about:srcdoc",
            "<anonymous>",
            "src/ts/x.ts",
            "/src/ts/x.ts",
            "",
        ]) {
            expect(clientAppPath(file), file).toBeNull();
        }
    });

    it("reads a V8 stack through the exact-header rule: dev sources (.svelte, .svelte.ts, shared), built chunks, at most 8 frames, nothing from a message or a changed header", () => {
        const { browserStack } = collector;
        const error = v8(new Error("boom"), [
            "    at Module.run (http://localhost:3000/src/lib/ChatScreens/Chat.svelte?svelte&type=style:1:2)",
            "    at http://localhost:3000/src/ts/storage/resourceSync.svelte.ts:3:4",
            "    at eval (eval at <anonymous> (http://localhost:3000/src/ts/x.ts:1:1), <anonymous>:1:1)",
            "    at http://localhost:3000/shared/cbs/parser.ts:5:6",
            "    at fn (blob:http://localhost:3000/0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c:7:8)",
            "    at fn (https://evil.example/src/ts/x.ts:9:10)",
            "    at <anonymous>",
            "    at fn (http://localhost:3000/src/ts/x.ts.bak:11:12)",
            "    at fn (http://localhost:3000/src/ts/Alice Private.ts:13:14)",
            "    at fn (http://localhost:3000/assets/rolldown-runtime-DkW27tQK.js:15:16)",
            "    at fn (http://localhost:3000/assets/index.js:17:18)",
            // The URL parser resolves a traversal before the path is read: no `..` reaches a frame.
            "    at fn (http://localhost:3000/assets/../src/x.js:19:20)",
            "    at fn (http://localhost:3000/src/a.ts:21:22)",
            "    at fn (http://localhost:3000/src/b.ts:23:24)",
            "    at fn (http://localhost:3000/src/c.ts:25:26)",
            "    at fn (http://localhost:3000/src/d.ts:27:28)",
            "    at fn (http://localhost:3000/src/e.ts:29:30)",
        ]);
        expect(browserStack(error)).toEqual([
            "src/lib/ChatScreens/Chat.svelte:1:2",
            "src/ts/storage/resourceSync.svelte.ts:3:4",
            "shared/cbs/parser.ts:5:6",
            "assets/rolldown-runtime-DkW27tQK.js:15:16",
            "src/x.js:19:20",
            "src/a.ts:21:22",
            "src/b.ts:23:24",
            "src/c.ts:25:26",
        ]);
        // A message holding a frame line is part of the header; a changed message reads nothing.
        const framed = v8(new Error("x\n    at evil (http://localhost:3000/src/evil.ts:9:9)"), [
            "    at fn (http://localhost:3000/src/real.ts:1:1)",
        ]);
        expect(browserStack(framed)).toEqual(["src/real.ts:1:1"]);
        framed.message = "y";
        expect(browserStack(framed)).toEqual([]);
        // A V8 stack whose header is the name alone (an empty message), and a header-only stack.
        expect(browserStack(v8(new RangeError(""), ["    at fn (http://localhost:3000/src/a.ts:1:1)"]))).toEqual([
            "src/a.ts:1:1",
        ]);
        expect(browserStack(withStack(new Error("x"), "Error: x"))).toEqual([]);
    });

    it("reads a Gecko or WebKit stack only when every line is a `…@url:line:col` frame, never one that starts with the error's name", () => {
        const { browserStack } = collector;
        const gecko = withStack(
            new TypeError("Alice's secret"),
            [
                "run@http://localhost:3000/src/ts/process/index.svelte.ts?t=1:12:34",
                "Async*send@http://localhost:3000/src/ts/x.ts:1:2",
                "@http://localhost:3000/src/lib/App.svelte:3:4",
                "node_modules@http://localhost:3000/node_modules/.vite/deps/x.js:5:6",
                "fn@https://evil.example/src/ts/x.ts:7:8",
                "fn@http://localhost:3000/assets/index-BZ0RKwIv.js:9:10",
                "",
            ].join("\n"),
        );
        expect(browserStack(gecko)).toEqual([
            "src/ts/process/index.svelte.ts:12:34",
            "src/ts/x.ts:1:2",
            "src/lib/App.svelte:3:4",
            "assets/index-BZ0RKwIv.js:9:10",
        ]);
        const webkit = withStack(
            new Error("x"),
            [
                "module code@http://localhost:3000/src/ts/x.ts:1:2",
                "global code@http://localhost:3000/src/startApp.ts:3:4",
            ].join("\n"),
        );
        expect(browserStack(webkit)).toEqual(["src/ts/x.ts:1:2", "src/startApp.ts:3:4"]);
        // A line that is not a frame (a native frame, a message, a header) reads nothing at all.
        for (const stack of [
            "promiseReactionJob@[native code]\nfn@http://localhost:3000/src/ts/x.ts:1:2",
            "fn@http://localhost:3000/src/ts/x.ts:1:2\nAlice said: hi",
            "Error: x\nfn@http://localhost:3000/src/ts/x.ts:1:2",
            "Error\nfn@http://localhost:3000/src/ts/x.ts:1:2",
            "Error: x@http://localhost:3000/src/ts/x.ts:1:2",
            "fn@http://localhost:3000/src/ts/x.ts:1",
        ]) {
            expect(browserStack(withStack(new Error("x"), stack)), stack).toEqual([]);
        }
        // Past 8 frames, the rest is dropped.
        const many = Array.from({ length: 12 }, (_, i) => `fn@http://localhost:3000/src/f${i}.ts:${i + 1}:1`).join(
            "\n",
        );
        expect(browserStack(withStack(new Error("x"), many))).toHaveLength(8);
    });

    it("reads no frames from a non-Error, a non-string or oversized stack, or a throwing accessor", () => {
        const { browserStack } = collector;
        const frame = "    at fn (http://localhost:3000/src/ts/x.ts:1:2)";
        expect(browserStack({ name: "Error", message: "x", stack: `Error: x\n${frame}` })).toEqual([]);
        expect(browserStack(`Error: x\n${frame}`)).toEqual([]);
        expect(browserStack(null)).toEqual([]);
        const odd = new Error("x");
        (odd as { stack: unknown }).stack = ["src/ts/x.ts:1:2"];
        expect(browserStack(odd)).toEqual([]);
        const huge = v8(new Error("x"), [frame, `    at fn (http://localhost:3000/src/${"a".repeat(70_000)}.ts:1:1)`]);
        expect(browserStack(huge)).toEqual([]);
        const throwing = new Error("x");
        Object.defineProperty(throwing, "stack", {
            get() {
                throw new Error("no");
            },
        });
        expect(browserStack(throwing)).toEqual([]);
    });
});
