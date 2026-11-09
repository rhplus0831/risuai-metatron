import {
    REALM_CANCEL_PATH,
    REALM_COMMIT_PATH,
    REALM_IMPORT_PATH,
    type RealmCommitted,
    type RealmPrepared,
} from "../../../shared/realmImport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { authFetch, getNodeServerProxyAuth } from "./serverAuth";
import {
    importOverServer,
    ServerImportAnswerError,
    ServerImportRequestError,
    type ServerImportOptions,
} from "./serverImportClient";

/**
 * The client of the server's Realm import (`server/src/routes/importRealm.ts`, `shared/realmImport.ts`),
 * the transport only: `downloadRisuHub` (`src/ts/characterCards.ts`) owns the import. The prepare
 * (`{ id }`) has the server download and stage the card and answers its card text; the commit
 * (`{ token }`) has it store the staged file's assets, as NDJSON read as it streams; the cancel removes
 * the staged file. A pagehide guard sends one best-effort keepalive cancel using auth signed ahead.
 * `commitRealmCard` retries a busy/maintenance commit refusal once after five seconds; this transport
 * classifies those refusals but never retries itself. Errors are the shared file import client's
 * (`serverImportClient.ts`).
 */

// The Realm commit route (`server/src/routes/importRealm.ts`) uses these refusals from
// `server/src/http/fileImport.ts` and `server/src/data/snapshots.ts` without consuming the stage.
const REALM_COMMIT_BUSY = "Another import is running";
const REALM_COMMIT_MAINTENANCE = "Maintenance in progress";
/** The server's `Retry-After: 5` delay for the one retry in `commitRealmCard`. */
export const REALM_COMMIT_RETRY_DELAY_MS = 5 * 1000;

/** Signed auth lives five minutes; pagehide must not use a token older than four. */
const REALM_UNLOAD_AUTH_MAX_AGE_MS = 4 * 60 * 1000;
const REALM_UNLOAD_AUTH_REFRESH_MS = 2 * 60 * 1000;
// Keep the sent flag until the caller releases, including when a pagehide survives in bfcache.
const realmPagehideGuards = new Map<string, { cancelSent: boolean; stop: () => void }>();

/** Only busy/maintenance request refusals preserve the stage for `commitRealmCard`'s one retry. */
export function isRetriableRealmCommitRefusal(error: unknown): boolean {
    return (
        error instanceof ServerImportRequestError &&
        ((error.status === 409 && error.serverError === REALM_COMMIT_BUSY) ||
            (error.status === 503 && error.serverError === REALM_COMMIT_MAINTENANCE))
    );
}

/**
 * Asks the server to download the Realm card `id` and stage it, writing nothing, and answers its
 * prepared line (`RealmPrepared`): staged PNG/CharX card text and token, plus an embedded
 * `module.risum` only for CharX; legacy JSON is passed through with no stage or token. The owner
 * registers `cancelRealmImportOnPagehide` as soon as it receives a staged token, before any prompts.
 * Throws `ServerImportRequestError` for a non-2xx answer,
 * `ServerImportFailedError` for a failure line, `ServerImportAnswerError` for a malformed answer, and
 * a network failure as it is (a `TypeError`).
 */
export function prepareRealmImport(id: string): Promise<RealmPrepared> {
    return importOverServer(
        REALM_IMPORT_PATH,
        { body: JSON.stringify({ id }), contentType: "application/json" },
        readPrepared,
    );
}

/**
 * Asks the server to store the assets of the staged import `token` and answers its committed line
 * (`RealmCommitted`), with `prepareRealmImport`'s errors (a 404 `REALM_IMPORT_EXPIRED` once the staged
 * import is gone). Does not retry: `commitRealmCard` retries only `isRetriableRealmCommitRefusal`
 * once after `REALM_COMMIT_RETRY_DELAY_MS`, keeping the pagehide guard registered while it waits.
 */
export function commitRealmImport(token: string, options: ServerImportOptions = {}): Promise<RealmCommitted> {
    return importOverServer(
        REALM_COMMIT_PATH,
        { body: JSON.stringify({ token }), contentType: "application/json" },
        readCommitted,
        options,
    );
}

/**
 * Removes the staged import unless its pagehide guard already sent a cancel. The guard stays armed
 * through asynchronous authentication, then stops at dispatch so the two paths send at most once.
 * Never throws: an import left staged expires. The caller releases the guard after this settles.
 */
export async function cancelRealmImport(token: string): Promise<void> {
    const guard = realmPagehideGuards.get(token);
    const alreadyCancelled = new Error("Realm import already cancelled on pagehide");
    try {
        if (guard?.cancelSent) return;
        await authFetch(
            REALM_CANCEL_PATH,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token }),
            },
            {
                beforeDispatch: () => {
                    if (guard?.cancelSent) throw alreadyCancelled;
                    if (guard) {
                        guard.cancelSent = true;
                        guard.stop();
                    }
                },
            },
        );
    } catch (error) {
        if (error !== alreadyCancelled) console.warn("Realm import cancel failed:", error);
    }
}

/**
 * Guards a staged token immediately, including time spent on prompts or the one commit retry.
 * Signs auth now and every two minutes: pagehide cannot await authentication/signing. Its one direct
 * keepalive cancel uses auth at most four minutes old, with no epoch header; all failures are
 * swallowed and the server's ten-minute TTL remains the fallback. Firing removes the listener and
 * timer. Release after a successful commit or normal cancel; release is idempotent.
 */
export function cancelRealmImportOnPagehide(token: string): () => void {
    let listening = true;
    let auth: { token: string; at: number } | null = null;
    let authPending = false;
    const guard = {
        cancelSent: false,
        stop: () => {
            if (!listening) return;
            listening = false;
            clearInterval(refreshTimer);
            window.removeEventListener("pagehide", onPagehide);
            auth = null;
        },
    };
    async function prepareAuth() {
        if (!listening || authPending) return;
        authPending = true;
        // Measure from before signing, so delayed authentication cannot make old auth look fresh.
        const at = Date.now();
        try {
            const signed = await getNodeServerProxyAuth();
            if (listening) auth = { token: signed, at };
        } catch {
            // Best effort: keep any previous auth; pagehide checks its age.
        } finally {
            authPending = false;
        }
    }
    function onPagehide() {
        const readyAuth = auth;
        guard.stop();
        if (guard.cancelSent || !readyAuth || Date.now() - readyAuth.at > REALM_UNLOAD_AUTH_MAX_AGE_MS) return;
        guard.cancelSent = true;
        try {
            void fetch(REALM_CANCEL_PATH, {
                method: "POST",
                keepalive: true,
                cache: "no-store",
                headers: { "content-type": "application/json", "risu-auth": readyAuth.token },
                body: JSON.stringify({ token }),
            }).catch(() => {});
        } catch {}
    }
    const refreshTimer = setInterval(() => void prepareAuth(), REALM_UNLOAD_AUTH_REFRESH_MS);
    realmPagehideGuards.set(token, guard);
    window.addEventListener("pagehide", onPagehide, { once: true });
    void prepareAuth();
    return () => {
        guard.stop();
        realmPagehideGuards.delete(token);
    };
}

/** The prepared line, told apart by its `kind`. */
function readPrepared(line: Record<string, unknown>): RealmPrepared | null {
    if (!("kind" in line)) {
        return null;
    }
    if (line.kind === "charx") {
        const { token, card, moduleData } = line;
        if (typeof token === "string" && typeof card === "string" && isTextOrNull(moduleData)) {
            return { kind: "charx", token, card, moduleData };
        }
    } else if (line.kind === "png") {
        const { token, card } = line;
        if (typeof token === "string" && typeof card === "string") {
            return { kind: "png", token, card };
        }
    } else if (line.kind === "json") {
        if (typeof line.body === "string") {
            return { kind: "json", body: line.body };
        }
    }
    throw new ServerImportAnswerError("The result line is not a Realm prepare result");
}

/** The committed line, told apart by its `kind`. */
function readCommitted(line: Record<string, unknown>): RealmCommitted | null {
    if (!("kind" in line)) {
        return null;
    }
    if (line.kind === "charx") {
        const { assets, excluded } = line;
        if (isKeyMap(assets) && Array.isArray(excluded) && excluded.every((name) => typeof name === "string")) {
            return { kind: "charx", assets, excluded };
        }
    } else if (line.kind === "png") {
        const { image, assets } = line;
        if (typeof image === "string" && isKeyMap(assets)) {
            return { kind: "png", image, assets };
        }
    }
    throw new ServerImportAnswerError("The result line is not a Realm commit result");
}

function isTextOrNull(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function isKeyMap(value: unknown): value is Record<string, string> {
    return isPlainObject(value) && Object.values(value).every((key) => typeof key === "string");
}
