import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalDiagnosticReport } from "../../../shared/diagnosticsReport.ts";
import versionData from "../../../version.json";

// Request history slice 9 (`docs/plan/request-history-diagnostics.md`, decision 6): the Diagnostics
// panel's report module (`report.ts`). The browser and OS families (never the user agent); the read
// of the server's diagnostics (`authFetch`, `ok` checked, every failure and a wait past 10 s a null,
// the fetch aborted); the report built from the tab's side with `Server: unavailable` when the
// server did not answer (the browser-only fallback), and `Server: current` when it did; and the save
// (`POST /api/diagnostics/report` as `text/plain`, the answer mapped to a fixed failure kind, the
// whole save bounded with `network` when nothing was sent, `timeout` after a dispatch, never retried).

const { deps } = vi.hoisted(() => ({
    deps: {
        authFetch:
            vi.fn<(path: string, init: RequestInit, options?: { beforeDispatch?: () => void }) => Promise<Response>>(),
        events: [] as unknown[],
    },
}));
vi.mock("../storage/serverAuth", () => ({
    authFetch: (...args: Parameters<typeof deps.authFetch>) => deps.authFetch(...args),
}));
vi.mock("./collector", () => ({
    clientDiagnosticEvents: () => deps.events,
}));

import { browserFamily, createDiagnosticReport, osFamily, readServerDiagnostics, saveDiagnosticReport } from "./report";

const JOB = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
const AT = Date.UTC(2026, 9, 13, 10, 15);
const PRIVATE = "Private Character said hello";
const CHROME_WINDOWS =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const never = () => new Promise<Response>(() => {});
const state = () => ({
    version: 1,
    writtenAt: new Date(AT - 500).toISOString(),
    app: { version: "2026.8.250" },
    node: "24.1.0",
    platform: "linux",
    arch: "x64",
    startedAt: new Date(AT - 60_000).toISOString(),
    uptimeSec: 60,
    settings: null,
    history: null,
    journal: { eventBytes: 0, writeFailures: 0 },
    workers: null,
    jobs: null,
    recentJobFailures: [],
});
const lines = (text: string) => text.slice(0, -1).split("\n");
/** The last `authFetch` call. */
const sent = () => {
    const call = deps.authFetch.mock.calls.at(-1);
    return call ? { path: call[0], init: call[1], options: call[2] } : null;
};

let userAgent = CHROME_WINDOWS;
let onLine = true;
beforeEach(() => {
    deps.authFetch.mockReset();
    deps.events = [];
    Object.defineProperty(navigator, "userAgent", { get: () => userAgent, configurable: true });
    Object.defineProperty(navigator, "onLine", { get: () => onLine, configurable: true });
    userAgent = CHROME_WINDOWS;
    onLine = true;
});
afterEach(() => {
    vi.useRealTimers();
});

describe("the families", () => {
    it("names the browser family by the user agent's tokens, Firefox and Edge before Chrome, Chrome before Safari, and `Other` for the rest", () => {
        expect(browserFamily(CHROME_WINDOWS)).toBe("Chrome");
        expect(
            browserFamily(
                "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
            ),
        ).toBe("Edge");
        expect(
            browserFamily(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/130.0 Mobile/15E148 Safari/605.1.15",
            ),
        ).toBe("Edge");
        expect(
            browserFamily(
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0",
            ),
        ).toBe("Edge");
        expect(browserFamily("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("Firefox");
        expect(
            browserFamily(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 FxiOS/130.0 Mobile/15E148 Safari/605.1.15",
            ),
        ).toBe("Firefox");
        expect(
            browserFamily(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0.0.0 Mobile/15E148 Safari/605.1.15",
            ),
        ).toBe("Chrome");
        expect(
            browserFamily(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            ),
        ).toBe("Safari");
        expect(browserFamily("curl/8.0")).toBe("Other");
        expect(browserFamily("")).toBe("Other");
        expect(browserFamily(`Chrome ${PRIVATE}`)).toBe("Other");
    });

    it("names the OS family, Android before Linux, the Apple devices before Macintosh, and `Other` for the rest", () => {
        expect(
            osFamily(
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36",
            ),
        ).toBe("Android");
        expect(osFamily("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("iOS");
        expect(osFamily("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("iOS");
        expect(osFamily("Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)")).toBe("iOS");
        expect(osFamily(CHROME_WINDOWS)).toBe("Windows");
        expect(osFamily("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("macOS");
        expect(osFamily("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe("Linux");
        expect(osFamily("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36")).toBe("Other");
        expect(osFamily("")).toBe("Other");
    });
});

describe("readServerDiagnostics", () => {
    it("asks `GET /api/diagnostics` through `authFetch` without caching and answers the state and events of a JSON answer, nothing else of it", async () => {
        deps.authFetch.mockResolvedValueOnce(
            json({ state: state(), events: [{ at: AT, kind: "lifecycle", phase: "boot" }], extra: PRIVATE }),
        );
        const answer = await readServerDiagnostics();
        expect(answer).toEqual({ state: state(), events: [{ at: AT, kind: "lifecycle", phase: "boot" }] });
        expect(Object.keys(answer!)).toEqual(["state", "events"]);
        const call = sent()!;
        expect(call.path).toBe("/api/diagnostics");
        expect(call.init.cache).toBe("no-store");
        expect(call.init.method).toBeUndefined();
        expect(call.init.signal).toBeInstanceOf(AbortSignal);
        expect(call.init.signal!.aborted).toBe(false);
        expect(deps.authFetch).toHaveBeenCalledTimes(1);
    });

    it("is null for an error answer, a body that is not JSON or not an object, a rejected fetch, and a wait past the bound (the fetch aborted then), never throwing", async () => {
        deps.authFetch.mockResolvedValueOnce(json({ error: "x" }, 401));
        expect(await readServerDiagnostics()).toBeNull();
        deps.authFetch.mockResolvedValueOnce(json({ error: "x" }, 503));
        expect(await readServerDiagnostics()).toBeNull();
        deps.authFetch.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
        expect(await readServerDiagnostics()).toBeNull();
        deps.authFetch.mockResolvedValueOnce(json(null));
        expect(await readServerDiagnostics()).toBeNull();
        deps.authFetch.mockResolvedValueOnce(json(42));
        expect(await readServerDiagnostics()).toBeNull();
        deps.authFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        expect(await readServerDiagnostics()).toBeNull();
        // A missing field is handed over as undefined: the report's projection decides.
        deps.authFetch.mockResolvedValueOnce(json({ events: [] }));
        expect(await readServerDiagnostics()).toEqual({ state: undefined, events: [] });

        vi.useFakeTimers();
        deps.authFetch.mockImplementationOnce(never);
        const pending = readServerDiagnostics(10_000);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(sent()!.init.signal!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toBeNull();
        expect(sent()!.init.signal!.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("createDiagnosticReport", () => {
    it("builds the report from this tab (the version, the families, online, the viewport, the ring) and says `Server: unavailable` when the server did not answer; the user agent never appears", async () => {
        deps.authFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        deps.events = [
            { at: AT, kind: "page", phase: "boot" },
            { at: AT + 1, kind: "jobLink", phase: "detach", jobId: JOB, code: 1006 },
            // Never the tab's: a server kind, free text; the report's projection drops them.
            { at: AT + 2, kind: "job", phase: "done", jobId: JOB },
            { at: AT + 3, kind: "page", phase: "visible", note: PRIVATE },
            PRIVATE,
        ];
        onLine = false;
        const text = await createDiagnosticReport();
        expect(lines(text).slice(0, 7)).toEqual([
            "Metatron diagnostic report v1",
            `Version: ${versionData.version}`,
            "Browser: Chrome",
            "OS: Windows",
            "Online: false",
            `Viewport: ${window.innerWidth} x ${window.innerHeight}`,
            expect.stringMatching(/^Exported: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        ]);
        expect(lines(text).slice(8, 11)).toEqual(["Server: unavailable", "Omitted events: 0", ""]);
        expect(lines(text).slice(11)).toEqual([
            `${new Date(AT).toISOString()} browser page {"phase":"boot"}`,
            `${new Date(AT + 1).toISOString()} browser jobLink {"phase":"detach","jobId":"${JOB}","code":1006}`,
            `${new Date(AT + 3).toISOString()} browser page {"phase":"visible"}`,
        ]);
        expect(text).not.toContain(PRIVATE);
        expect(text).not.toContain("Mozilla");
        expect(text).not.toContain("Win64");
        expect(canonicalDiagnosticReport(text)).toBe(text);
        expect(deps.authFetch).toHaveBeenCalledTimes(1);
    });

    it("says `Server: current` with the server's state and events when it answered, and `unavailable` when its state is not a v1 state", async () => {
        userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
        deps.authFetch.mockResolvedValueOnce(
            json({ state: state(), events: [{ at: AT - 1, kind: "lifecycle", phase: "boot" }] }),
        );
        deps.events = [{ at: AT, kind: "page", phase: "boot" }];
        const text = await createDiagnosticReport();
        expect(lines(text).slice(2, 4)).toEqual(["Browser: Safari", "OS: macOS"]);
        expect(lines(text)[8]).toBe("Server: current");
        expect(lines(text)[9]).toBe(`Server state: ${JSON.stringify(state())}`);
        expect(lines(text).slice(12)).toEqual([
            `${new Date(AT - 1).toISOString()} server lifecycle {"phase":"boot"}`,
            `${new Date(AT).toISOString()} browser page {"phase":"boot"}`,
        ]);
        expect(canonicalDiagnosticReport(text)).toBe(text);

        deps.authFetch.mockResolvedValueOnce(
            json({ state: { version: 2 }, events: [{ at: AT - 1, kind: "lifecycle", phase: "boot" }] }),
        );
        const stale = await createDiagnosticReport();
        expect(lines(stale)[8]).toBe("Server: unavailable");
        expect(stale).not.toContain("lifecycle");
    });
});

describe("saveDiagnosticReport", () => {
    const TEXT = "Metatron diagnostic report v1\n";

    it("posts the text as `text/plain` to `/api/diagnostics/report` with a signal and a dispatch hook, and answers the saved name of a valid one, null for another or no JSON", async () => {
        deps.authFetch.mockResolvedValueOnce(json({ name: "20261013T101500123Z-0123abcd.txt" }));
        expect(await saveDiagnosticReport(TEXT)).toEqual({ ok: true, name: "20261013T101500123Z-0123abcd.txt" });
        const call = sent()!;
        expect(call.path).toBe("/api/diagnostics/report");
        expect(call.init.method).toBe("POST");
        expect(call.init.body).toBe(TEXT);
        expect(call.init.headers).toEqual({ "Content-Type": "text/plain; charset=utf-8" });
        expect(call.init.signal).toBeInstanceOf(AbortSignal);
        expect(typeof call.options?.beforeDispatch).toBe("function");
        deps.authFetch.mockResolvedValueOnce(json({ name: `../${PRIVATE}` }));
        expect(await saveDiagnosticReport(TEXT)).toEqual({ ok: true, name: null });
        deps.authFetch.mockResolvedValueOnce(json({}));
        expect(await saveDiagnosticReport(TEXT)).toEqual({ ok: true, name: null });
        deps.authFetch.mockResolvedValueOnce(new Response("ok", { status: 200 }));
        expect(await saveDiagnosticReport(TEXT)).toEqual({ ok: true, name: null });
        deps.authFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
        expect(await saveDiagnosticReport(TEXT)).toEqual({ ok: true, name: null });
    });

    it("maps an error answer to a fixed failure with its status (400 refused, 413 too large, 503 unavailable, any other failed) and a rejection to `network`, without the answer's text", async () => {
        const answers: [number, string][] = [
            [400, "refused"],
            [413, "tooLarge"],
            [503, "unavailable"],
            [500, "failed"],
            [401, "failed"],
            [429, "failed"],
        ];
        for (const [status, failure] of answers) {
            deps.authFetch.mockResolvedValueOnce(json({ error: PRIVATE }, status));
            expect(await saveDiagnosticReport(TEXT)).toEqual({ ok: false, failure, status });
        }
        deps.authFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        expect(await saveDiagnosticReport(TEXT)).toEqual({ ok: false, failure: "network", status: null });
        deps.authFetch.mockRejectedValueOnce(PRIVATE);
        expect(await saveDiagnosticReport(TEXT)).toEqual({ ok: false, failure: "network", status: null });
        expect(deps.authFetch).toHaveBeenCalledTimes(answers.length + 2);
    });

    it("bounds the whole save: past the wait before a dispatch it is `network` and the request is never sent (the hook refuses it); after a dispatch it is `timeout` and the fetch is aborted; never retried", async () => {
        vi.useFakeTimers();
        // The auth check outlasts the wait: the hook has not run when the wait ends.
        let hook: (() => void) | undefined;
        deps.authFetch.mockImplementationOnce((_path, _init, options) => {
            hook = options?.beforeDispatch;
            return never();
        });
        const slowAuth = saveDiagnosticReport(TEXT, 30_000);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(hook).toBeDefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(await slowAuth).toEqual({ ok: false, failure: "network", status: null });
        expect(() => hook!()).toThrow();
        expect(sent()!.init.signal!.aborted).toBe(true);
        expect(deps.authFetch).toHaveBeenCalledTimes(1);

        // Sent, no answer in time: it may have been saved.
        deps.authFetch.mockImplementationOnce((_path, _init, options) => {
            options?.beforeDispatch?.();
            return never();
        });
        const unanswered = saveDiagnosticReport(TEXT, 30_000);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await unanswered).toEqual({ ok: false, failure: "timeout", status: null });
        expect(sent()!.init.signal!.aborted).toBe(true);
        expect(deps.authFetch).toHaveBeenCalledTimes(2);

        // Sent and answered, but the answer's body never arrives.
        deps.authFetch.mockImplementationOnce(async (_path, _init, options) => {
            options?.beforeDispatch?.();
            return new Response(new ReadableStream({ start() {} }), { status: 200 });
        });
        const bodiless = saveDiagnosticReport(TEXT, 30_000);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await bodiless).toEqual({ ok: false, failure: "timeout", status: null });
        expect(vi.getTimerCount()).toBe(0);
    });
});
