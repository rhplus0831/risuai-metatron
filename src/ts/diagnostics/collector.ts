import {
    apiRouteTemplate,
    type DiagnosticEvent,
    type DiagnosticEventInput,
    errorName,
    isApiPath,
    isStackFrame,
    MAX_STACK_FRAMES,
    projectDiagnosticEvent,
    sanitizeStack,
} from "../../../shared/diagnostics.ts";

/**
 * The browser's diagnostics (`docs/plan/request-history-diagnostics.md` slice 8): a ring of the last
 * 300 content-free events of this tab (`projectClientEvent`), mirrored to `sessionStorage` so a
 * reload keeps them. Nothing is sent anywhere: the Diagnostics panel's report reads it (decision 6).
 *
 * - `recordClientEvent` works before `startDiagnosticsCollector` (a hook that runs early, tests). An
 *   event identical to one of the last 16 (but for its time and duration), whose last occurrence is
 *   at most 10 minutes old, is folded into it (`repeat`, `lastAt`), so a retry loop (a 409 and its
 *   `sync conflict` every few seconds) does not flush the ring. A page's `boot` is never folded.
 * - `startDiagnosticsCollector` (first in `src/boot.ts`, before the app's modules load) restores the
 *   stored ring, then watches this window only (a plugin's iframe is another realm): same-origin API
 *   fetches that fail (`window.fetch`, wrapped), uncaught errors and rejections, visibility, online
 *   state, and the service worker's controller. The other hooks call `recordClientEvent` where their
 *   event happens (job follows, the live-update socket, the save loop, the service worker setup).
 * - The mirror is written at most a second after an event (a pending write is not postponed), when
 *   the page is hidden or left, and before the app reloads the page (`flushClientDiagnostics`); the
 *   oldest events are left out until it fits the size the restore reads. Every storage access is
 *   guarded: without storage the ring still works in memory.
 * - Nothing here throws into the app: every listener and the fetch wrapper's observation are guarded.
 */

const RING_SIZE = 300;
const STORAGE_KEY = "risu-diagnostics";
/** A stored ring larger than this (characters) is not read; the mirror is cut to fit it. */
const MAX_STORED_CHARS = 512 * 1024;
const FLUSH_DELAY_MS = 1000;
/** A stack longer than this (characters) is not read. */
const MAX_STACK_CHARS = 64 * 1024;
/** How far back, in events and in time, an identical event is folded into an earlier one. */
const FOLD_EVENTS = 16;
const FOLD_MS = 10 * 60_000;

/** The kinds the browser writes; the server's (`job`, `request`, `lifecycle`) are never the tab's. */
const CLIENT_KINDS: ReadonlySet<string> = new Set([
    "http",
    "runtime",
    "jobLink",
    "feed",
    "sync",
    "serviceWorker",
    "page",
]);
const CLIENT_RUNTIME_ORIGINS: ReadonlySet<unknown> = new Set(["error", "unhandledrejection"]);

let ring: DiagnosticEvent[] = [];
let started = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The browser's projection: `projectDiagnosticEvent`, then only the browser's kinds and runtime
 * origins, without a server-only field (a `runtime` event's `jobId`). Used when recording and when
 * restoring the stored ring (storage is not trusted).
 */
export function projectClientEvent(input: unknown): DiagnosticEvent | null {
    const event = projectDiagnosticEvent(input);
    if (!event || !CLIENT_KINDS.has(event.kind)) {
        return null;
    }
    if (event.kind === "runtime") {
        if (!CLIENT_RUNTIME_ORIGINS.has(event.origin)) {
            return null;
        }
        delete event.jobId;
    }
    return event;
}

/** The fields that make two events the same for folding: all but the times, the duration, and the count. */
function sameEvent(a: DiagnosticEvent, b: DiagnosticEvent): boolean {
    const keys = (event: DiagnosticEvent) =>
        Object.keys(event).filter(
            (key) => key !== "at" && key !== "lastAt" && key !== "durationMs" && key !== "repeat",
        );
    const aKeys = keys(a);
    const bKeys = keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

/** The recent event `event` folds into, or null. */
function foldTarget(event: DiagnosticEvent): DiagnosticEvent | null {
    if (event.kind === "page" && event.phase === "boot") {
        return null;
    }
    for (let i = ring.length - 1; i >= Math.max(0, ring.length - FOLD_EVENTS); i--) {
        const candidate = ring[i];
        const last = typeof candidate.lastAt === "number" ? candidate.lastAt : candidate.at;
        if (event.at - last <= FOLD_MS && sameEvent(candidate, event)) {
            return candidate;
        }
    }
    return null;
}

/** Records one event of this tab: projected, folded into a recent identical one. Never throws. */
export function recordClientEvent(input: DiagnosticEventInput): void {
    try {
        const event = projectClientEvent({ ...input, at: Date.now() });
        if (!event) {
            return;
        }
        const target = foldTarget(event);
        if (target) {
            const repeat = typeof target.repeat === "number" ? target.repeat : 1;
            target.repeat = Math.min(repeat + 1, Number.MAX_SAFE_INTEGER);
            target.lastAt = event.at;
        } else {
            ring.push(event);
            if (ring.length > RING_SIZE) {
                ring.splice(0, ring.length - RING_SIZE);
            }
        }
        scheduleFlush();
    } catch {}
}

/** The ring, oldest first, as copies. */
export function clientDiagnosticEvents(): DiagnosticEvent[] {
    return ring.map(copy);
}

/**
 * Writes the ring to `sessionStorage` now (before a reload, when the page is hidden), without its
 * oldest events while it would be larger than the restore reads. Never throws.
 */
export function flushClientDiagnostics(): void {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    try {
        let kept = ring;
        let text = JSON.stringify(kept);
        while (text.length > MAX_STORED_CHARS && kept.length > 0) {
            kept = kept.slice(Math.max(1, Math.ceil(kept.length / 10)));
            text = JSON.stringify(kept);
        }
        sessionStorage.setItem(STORAGE_KEY, text);
    } catch {}
}

function scheduleFlush() {
    if (flushTimer) {
        return;
    }
    try {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushClientDiagnostics();
        }, FLUSH_DELAY_MS);
    } catch {}
}

/** The stored ring, each entry projected again (storage is not trusted), newest 300. */
function restore(): DiagnosticEvent[] {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (typeof raw !== "string" || raw.length > MAX_STORED_CHARS) {
            return [];
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .map((entry) => projectClientEvent(entry))
            .filter((event): event is DiagnosticEvent => event !== null)
            .slice(-RING_SIZE);
    } catch {
        return [];
    }
}

/**
 * The application path of a browser stack frame's file: a URL of this origin under `/src/` or
 * `/shared/` (the dev server) or `/assets/` (the build), without its query; null for anything else
 * (a dependency, `blob:`, `data:`, `about:srcdoc`, an eval location, another origin).
 */
export function clientAppPath(file: string): string | null {
    try {
        const url = new URL(file);
        if (url.origin !== location.origin || !/^\/(?:src|shared|assets)\//.test(url.pathname)) {
            return null;
        }
        return url.pathname.slice(1);
    } catch {
        return null;
    }
}

/** A Gecko or WebKit frame: `function@url:line:col` (the function's name is dropped). */
const AT_FRAME = /@([^@\s]+):(\d{1,7}):(\d{1,7})$/;

/**
 * The application frames of a browser error's stack. A V8 stack (Chromium) goes through
 * `sanitizeStack` (its header must be exactly the error's, so the message is never read). A Gecko or
 * WebKit stack has no message: it is read only when every line is a `…@url:line:col` frame. Anything
 * else, a value that is not an `Error` of this window, or a stack past 64K characters, gives no
 * frames. Never throws.
 *
 * The file of a frame is checked by origin and path (`clientAppPath`, `CLIENT_FRAME`), not by
 * membership in the build: code of this window that rewrites an error's `stack` could still name a
 * file shaped like the app's. Nothing in the app does; a plugin runs in another realm.
 */
export function browserStack(error: unknown): string[] {
    try {
        // Only an error of this window: a plain object's (or another realm's) `stack` is anyone's text.
        if (!(error instanceof Error)) {
            return [];
        }
        const stack = error.stack;
        if (typeof stack !== "string" || stack.length > MAX_STACK_CHARS) {
            return [];
        }
        const v8 = sanitizeStack(error, clientAppPath);
        if (v8.length > 0) {
            return v8;
        }
        // A V8 stack starts with its header (the name, then the message): never read as frames.
        const name = (error as { name?: unknown }).name;
        if (
            typeof name === "string" &&
            (stack === name || stack.startsWith(`${name}:`) || stack.startsWith(`${name}\n`))
        ) {
            return [];
        }
        const lines = stack.split("\n").filter((line) => line !== "");
        const frames: string[] = [];
        for (const line of lines) {
            const frame = AT_FRAME.exec(line);
            if (!frame) {
                return [];
            }
            const file = clientAppPath(frame[1]);
            const located = file === null ? null : `${file}:${frame[2]}:${frame[3]}`;
            if (located !== null && isStackFrame(located) && frames.length < MAX_STACK_FRAMES) {
                frames.push(located);
            }
        }
        return frames;
    } catch {
        return [];
    }
}

function recordError(origin: "error" | "unhandledrejection", error: unknown) {
    recordClientEvent({ kind: "runtime", origin, name: errorName(error), stack: browserStack(error) });
}

type FetchTarget = { method: string; route: string; signal: AbortSignal | null | undefined };

/**
 * What a fetch was for, when it is a same-origin API fetch: its method, route template, and
 * effective signal (`init.signal` when given, `null` included; else the request's). Read after the
 * fetch was dispatched, each property once, so a getter it runs cannot change the request.
 */
function describeFetch(input: unknown, init: RequestInit | undefined): FetchTarget | null {
    let url: string | null = null;
    let method: unknown;
    let signal: AbortSignal | null | undefined;
    if (typeof input === "string") {
        url = input;
    } else if (input instanceof URL) {
        url = input.href;
    } else if (typeof input === "object" && input !== null) {
        // A `Request`, of this realm or another.
        const request = input as Partial<Request>;
        const requestUrl = request.url;
        url = typeof requestUrl === "string" ? requestUrl : null;
        method = request.method;
        signal = request.signal;
    }
    if (init) {
        const initMethod = init.method;
        if (initMethod !== undefined) {
            method = initMethod;
        }
        const initSignal = init.signal;
        if (initSignal !== undefined) {
            signal = initSignal;
        }
    }
    if (url === null) {
        return null;
    }
    const resolved = new URL(url, document.baseURI);
    if (resolved.origin !== location.origin || !isApiPath(resolved.pathname)) {
        return null;
    }
    return {
        method: typeof method === "string" ? method.toUpperCase() : "GET",
        route: apiRouteTemplate(resolved.pathname),
        signal,
    };
}

/** An `http` event for a fetch that answered 400 or more, or rejected (an abort only when it timed out). */
function observeFetch(target: FetchTarget, durationMs: number, outcome: { response: Response } | { error: unknown }) {
    const { method, route, signal } = target;
    if ("response" in outcome) {
        if (outcome.response.status >= 400) {
            recordClientEvent({ kind: "http", method, route, status: outcome.response.status, durationMs });
        }
        return;
    }
    const reason = signal?.aborted === true ? signal.reason : undefined;
    const timedOut = errorName(outcome.error) === "TimeoutError" || errorName(reason) === "TimeoutError";
    const aborted = signal?.aborted === true || errorName(outcome.error) === "AbortError";
    if (timedOut || !aborted) {
        recordClientEvent({ kind: "http", method, route, failure: timedOut ? "timeout" : "rejected", durationMs });
    }
}

/**
 * Wraps `window.fetch`: the original is called once, first, with the same receiver and arguments.
 * The promise returned resolves with the same response and rejects with the same reason (a promise
 * chained on the original's, so a rejection nobody handles is still unhandled); no body is read.
 * Beside it, a same-origin API fetch that answers 400 or more, or rejects without an answer, is an
 * `http` event (`observeFetch`). The duration ends when the fetch settles, not when a streamed body
 * ends; a `keepalive` fetch the page outlives is never observed.
 */
function wrapFetch() {
    const original = window.fetch;
    if (typeof original !== "function") {
        return;
    }
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
        const started = performance.now();
        const result = original.apply(this === undefined || this === null ? window : this, args);
        let target: FetchTarget | null = null;
        try {
            target = describeFetch(args[0], args[1]);
        } catch {}
        if (!target) {
            return result;
        }
        const observed = target;
        const durationMs = () => Math.max(0, Math.round(performance.now() - started));
        return result.then(
            (response) => {
                try {
                    observeFetch(observed, durationMs(), { response });
                } catch {}
                return response;
            },
            (error: unknown) => {
                try {
                    observeFetch(observed, durationMs(), { error });
                } catch {}
                throw error;
            },
        );
    };
}

/**
 * Starts the collector once: restores the stored ring (before the events this page recorded so far),
 * records the page's boot, wraps `window.fetch`, and adds its listeners (never replacing the page's
 * own handlers).
 */
export function startDiagnosticsCollector(): void {
    if (started) {
        return;
    }
    started = true;
    try {
        ring = [...restore(), ...ring].slice(-RING_SIZE);
    } catch {}
    recordClientEvent({ kind: "page", phase: "boot" });
    try {
        wrapFetch();
    } catch {}
    const listen = (target: EventTarget | undefined, type: string, listener: (event: Event) => void) => {
        try {
            target?.addEventListener(type, (event) => {
                try {
                    listener(event);
                } catch {}
            });
        } catch {}
    };
    listen(window, "error", (event) => recordError("error", (event as ErrorEvent).error));
    listen(window, "unhandledrejection", (event) =>
        recordError("unhandledrejection", (event as PromiseRejectionEvent).reason),
    );
    listen(document, "visibilitychange", () => {
        const hidden = document.visibilityState === "hidden";
        recordClientEvent({ kind: "page", phase: hidden ? "hidden" : "visible" });
        if (hidden) {
            flushClientDiagnostics();
        }
    });
    listen(window, "pagehide", () => flushClientDiagnostics());
    listen(window, "online", () => recordClientEvent({ kind: "page", phase: "online" }));
    listen(window, "offline", () => recordClientEvent({ kind: "page", phase: "offline" }));
    let serviceWorker: ServiceWorkerContainer | undefined;
    try {
        serviceWorker = navigator.serviceWorker;
    } catch {}
    listen(serviceWorker, "controllerchange", () =>
        recordClientEvent({ kind: "serviceWorker", phase: "controllerChange" }),
    );
}

function copy(event: DiagnosticEvent): DiagnosticEvent {
    const out: DiagnosticEvent = { ...event };
    for (const [key, value] of Object.entries(out)) {
        if (Array.isArray(value)) {
            out[key] = [...value];
        }
    }
    return out;
}
