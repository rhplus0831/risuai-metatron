import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DIAGNOSTICS_PATH, DIAGNOSTICS_REPORT_PATH } from "../../../shared/diagnostics.ts";
import { canonicalDiagnosticReport, MAX_DIAGNOSTIC_REPORT_BYTES } from "../../../shared/diagnosticsReport.ts";
import type { DiagnosticsJournal } from "../diagnostics/journal.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

export { DIAGNOSTICS_PATH, DIAGNOSTICS_REPORT_PATH };

/**
 * The server's diagnostics for the app's Diagnostics panel (`docs/plan/request-history-diagnostics.md`
 * slices 8 and 9): JWT, the shared limiter. The app's admission middleware refuses both during
 * shutdown and makes every answer `no-store`.
 *
 * - `GET /api/diagnostics` answers `{ events, state }`: the journal's ring (the last 300 events,
 *   oldest first) and its state (`state.json`'s fields, built now). Both are in memory and
 *   content-free, so the answer works during a maintenance and when the folder cannot be written;
 *   nothing is written by a read.
 * - `POST /api/diagnostics/report` saves the panel's report (a `text/plain` body of at most 1 MiB, its
 *   own limit after the auth) to the folder's `reports/` and answers `{ name }`. Only a text
 *   `canonicalDiagnosticReport` accepts is kept (400 otherwise), so nothing outside the report's
 *   projections reaches the folder; the text is never logged. A save that cannot be written is 500.
 *   Shutdown is checked again right before the write (a slow body read can outlast the admission),
 *   so nothing lands after the final state; a maintenance does not stop it (no resource is touched).
 */
export function registerDiagnosticsRoutes(
    app: Hono<AppEnv>,
    arg: {
        journal: DiagnosticsJournal;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        shuttingDown: () => boolean;
    },
) {
    const { journal, auth, limiter, shuttingDown } = arg;
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };
    const limitBody = bodyLimit({
        maxSize: MAX_DIAGNOSTIC_REPORT_BYTES,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });

    app.get(DIAGNOSTICS_PATH, limiter, authenticated, (c) =>
        c.json({ events: journal.recent(), state: journal.state() }),
    );

    app.post(DIAGNOSTICS_REPORT_PATH, limiter, authenticated, limitBody, async (c) => {
        let text: string;
        try {
            text = await c.req.text();
        } catch {
            return c.json({ error: "Could not read the report" }, 400);
        }
        // The limiter trusts a declared length; the body read is measured again.
        if (Buffer.byteLength(text, "utf8") > MAX_DIAGNOSTIC_REPORT_BYTES) {
            return c.json({ error: "Request body too large" }, 413);
        }
        const report = canonicalDiagnosticReport(text);
        if (report === null) {
            return c.json({ error: "Not a diagnostic report" }, 400);
        }
        if (shuttingDown()) {
            c.header("Retry-After", "5");
            return c.json({ error: "The server is shutting down" }, 503);
        }
        const saved = journal.saveReport(report);
        if (!saved.ok) {
            return c.json({ error: "Could not save the report" }, 500);
        }
        return c.json({ name: saved.name });
    });
}
