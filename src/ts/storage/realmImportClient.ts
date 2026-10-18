import { REALM_IMPORT_PATH, type RealmImportResult } from "../../../shared/realmImport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { readCharxResult } from "./charxImportClient";
import { importOverServer, ServerImportAnswerError, type ServerImportOptions } from "./serverImportClient";

/**
 * The client of the server's Realm download (`POST /api/import/realm`, `server/src/routes/importRealm.ts`),
 * the transport only: `downloadRisuHub` (`src/ts/characterCards.ts`) owns the import. The request is
 * `{ id }`; the server downloads the card, stores its assets, and answers NDJSON (`RealmImportLine`)
 * read as it streams, with the shared file import client's errors (`serverImportClient.ts`).
 */

/**
 * Asks the server to download the Realm card `id` and answers its result (`RealmImportResult`).
 * Throws `ServerImportRequestError` for a non-2xx answer, `ServerImportFailedError` for a failure
 * line, `ServerImportAnswerError` for a malformed answer, and a network failure as it is (a `TypeError`).
 */
export function importRealmOverServer(id: string, options: ServerImportOptions = {}): Promise<RealmImportResult> {
    return importOverServer(
        REALM_IMPORT_PATH,
        { body: JSON.stringify({ id }), contentType: "application/json" },
        readRealmResult,
        options,
    );
}

/** The result line, told apart by its `kind`, with the shape the importer reads. */
function readRealmResult(line: Record<string, unknown>): RealmImportResult | null {
    if (!("kind" in line)) {
        return null;
    }
    if (line.kind === "charx") {
        const result = readCharxResult(line);
        if (result) {
            return { kind: "charx", ...result };
        }
    } else if (line.kind === "png") {
        const { card, image, assets } = line;
        if (
            isTextOrNull(card) &&
            typeof image === "string" &&
            isPlainObject(assets) &&
            Object.values(assets).every((key) => typeof key === "string")
        ) {
            return { kind: "png", card, image, assets: assets as Record<string, string> };
        }
    } else if (line.kind === "json") {
        if (typeof line.body === "string") {
            return { kind: "json", body: line.body };
        }
    }
    throw new ServerImportAnswerError("The result line is not a Realm import result");
}

function isTextOrNull(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}
