import { DIAGNOSTICS_PATH, DIAGNOSTICS_REPORT_PATH } from "../../../shared/diagnostics.ts";
import { buildDiagnosticReport, REPORT_FILE_PATTERN } from "../../../shared/diagnosticsReport.ts";
import versionData from "../../../version.json";
import { authFetch } from "../storage/serverAuth";
import { clientDiagnosticEvents } from "./collector";

/**
 * The Diagnostics panel's report: built here from this tab's ring and the server's `GET /api/diagnostics`,
 * through `shared/diagnosticsReport.ts` (which checks every value). Building only reads; the report leaves
 * the tab only by the user's Copy, Download, or Save to server (`saveDiagnosticReport`).
 */

/** How long the report waits for the server's diagnostics (the auth check included) before it goes without them. */
const SERVER_WAIT_MS = 10_000;
/** How long a save waits for the server's answer before it says it could not confirm the save. */
const SAVE_WAIT_MS = 30_000;

/** The browser family of a user agent; never the user agent itself. */
export function browserFamily(userAgent: string): string {
    if (/Firefox\/|FxiOS\//.test(userAgent)) {
        return "Firefox";
    }
    if (/Edg\/|EdgiOS\/|EdgA\//.test(userAgent)) {
        return "Edge";
    }
    if (/Chrome\/|CriOS\//.test(userAgent)) {
        return "Chrome";
    }
    if (/Safari\//.test(userAgent)) {
        return "Safari";
    }
    return "Other";
}

/** The OS family of a user agent. */
export function osFamily(userAgent: string): string {
    if (/Android/.test(userAgent)) {
        return "Android";
    }
    if (/iPhone|iPad|iPod/.test(userAgent)) {
        return "iOS";
    }
    if (/Windows/.test(userAgent)) {
        return "Windows";
    }
    if (/Macintosh/.test(userAgent)) {
        return "macOS";
    }
    if (/Linux/.test(userAgent)) {
        return "Linux";
    }
    return "Other";
}

/**
 * The server's diagnostics (`{ state, events }`, unchecked: the report projects them), or null when
 * the server did not answer them within 10 s, answered an error, or answered something else. Never
 * throws.
 */
export async function readServerDiagnostics(waitMs: number = SERVER_WAIT_MS): Promise<{
    state: unknown;
    events: unknown;
} | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(null);
        }, waitMs);
    });
    const read = (async () => {
        try {
            const response = await authFetch(DIAGNOSTICS_PATH, { cache: "no-store", signal: controller.signal });
            if (!response.ok) {
                return null;
            }
            const body = (await response.json()) as unknown;
            if (typeof body !== "object" || body === null) {
                return null;
            }
            const { state, events } = body as { state?: unknown; events?: unknown };
            return { state, events };
        } catch {
            return null;
        }
    })();
    try {
        return await Promise.race([read, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** The report of this tab and the server now. Never throws. */
export async function createDiagnosticReport(): Promise<string> {
    const server = await readServerDiagnostics();
    const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
    return buildDiagnosticReport({
        meta: {
            version: versionData.version,
            browser: browserFamily(userAgent),
            os: osFamily(userAgent),
            online: typeof navigator === "undefined" ? false : navigator.onLine,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            exportedAt: Date.now(),
        },
        server,
        browser: clientDiagnosticEvents(),
    });
}

/**
 * Why a save failed: the server refused the text (an older or newer tab's format: build it again),
 * it was too large, the server is shutting down, it could not write it, it was never sent (no
 * connection, or the auth check outlasted the wait), or it was sent and no answer came in time (it
 * may have been saved).
 */
export type SaveReportFailure = "refused" | "tooLarge" | "unavailable" | "failed" | "network" | "timeout";

export type SaveReportResult =
    { ok: true; name: string | null } | { ok: false; failure: SaveReportFailure; status: number | null };

/**
 * `POST /api/diagnostics/report` with `text`, waited for at most 30 s (the auth check, the answer, and
 * its body); past that the request is aborted, and one the auth check had not sent yet never is. The
 * saved file's name when the server gave a valid one. Never throws; never retries.
 */
export async function saveDiagnosticReport(text: string, waitMs: number = SAVE_WAIT_MS): Promise<SaveReportResult> {
    const controller = new AbortController();
    let expired = false;
    let dispatched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SaveReportResult>((resolve) => {
        timer = setTimeout(() => {
            expired = true;
            controller.abort();
            resolve({ ok: false, failure: dispatched ? "timeout" : "network", status: null });
        }, waitMs);
    });
    const save = (async (): Promise<SaveReportResult> => {
        let response: Response;
        try {
            response = await authFetch(
                DIAGNOSTICS_REPORT_PATH,
                {
                    method: "POST",
                    headers: { "Content-Type": "text/plain; charset=utf-8" },
                    body: text,
                    signal: controller.signal,
                },
                {
                    beforeDispatch: () => {
                        if (expired) {
                            throw new Error("The save timed out before it was sent");
                        }
                        dispatched = true;
                    },
                },
            );
        } catch {
            return { ok: false, failure: "network", status: null };
        }
        if (!response.ok) {
            const failure: SaveReportFailure =
                response.status === 400
                    ? "refused"
                    : response.status === 413
                      ? "tooLarge"
                      : response.status === 503
                        ? "unavailable"
                        : "failed";
            return { ok: false, failure, status: response.status };
        }
        try {
            const body = (await response.json()) as { name?: unknown } | null;
            const name = body?.name;
            return { ok: true, name: typeof name === "string" && REPORT_FILE_PATTERN.test(name) ? name : null };
        } catch {
            return { ok: true, name: null };
        }
    })();
    try {
        return await Promise.race([save, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
