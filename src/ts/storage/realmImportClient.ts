import {
    REALM_CANCEL_PATH,
    REALM_COMMIT_PATH,
    REALM_IMPORT_PATH,
    type RealmCommitted,
    type RealmPrepared,
} from "../../../shared/realmImport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { authFetch } from "./serverAuth";
import { importOverServer, ServerImportAnswerError, type ServerImportOptions } from "./serverImportClient";

/**
 * The client of the server's Realm import (`server/src/routes/importRealm.ts`, `shared/realmImport.ts`),
 * the transport only: `downloadRisuHub` (`src/ts/characterCards.ts`) owns the import. The prepare
 * (`{ id }`) has the server download and stage the card and answers its card text; the commit
 * (`{ token }`) has it store the staged file's assets, as NDJSON read as it streams; the cancel removes
 * the staged file. Errors are the shared file import client's (`serverImportClient.ts`).
 */

/**
 * Asks the server to download the Realm card `id` and stage it, writing nothing, and answers its
 * prepared line (`RealmPrepared`). Throws `ServerImportRequestError` for a non-2xx answer,
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
 * import is gone).
 */
export function commitRealmImport(token: string, options: ServerImportOptions = {}): Promise<RealmCommitted> {
    return importOverServer(
        REALM_COMMIT_PATH,
        { body: JSON.stringify({ token }), contentType: "application/json" },
        readCommitted,
        options,
    );
}

/** Asks the server to remove the staged import `token`. Never throws: an import left staged expires. */
export async function cancelRealmImport(token: string): Promise<void> {
    try {
        await authFetch(REALM_CANCEL_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
        });
    } catch (error) {
        console.warn("Realm import cancel failed:", error);
    }
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
