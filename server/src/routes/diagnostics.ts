import type { Hono, MiddlewareHandler } from "hono";
import { DIAGNOSTICS_PATH } from "../../../shared/diagnostics.ts";
import type { DiagnosticsJournal } from "../diagnostics/journal.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

export { DIAGNOSTICS_PATH };

/**
 * The server's diagnostics for the app's Diagnostics panel (`docs/plan/request-history-diagnostics.md`
 * slice 8): JWT, the shared limiter. `GET /api/diagnostics` answers `{ events, state }`: the journal's
 * ring (the last 300 events, oldest first) and its state (`state.json`'s fields, built now). Both are
 * in memory and content-free, so the answer works during a maintenance and when the folder cannot be
 * written; nothing is written by a read. The app's admission middleware refuses it during shutdown
 * and makes every answer `no-store`.
 */
export function registerDiagnosticsRoutes(
    app: Hono<AppEnv>,
    arg: { journal: DiagnosticsJournal; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { journal, auth, limiter } = arg;
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };
    app.get(DIAGNOSTICS_PATH, limiter, authenticated, (c) =>
        c.json({ events: journal.recent(), state: journal.state() }),
    );
}
