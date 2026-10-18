/**
 * The Realm import (`server/src/routes/importRealm.ts`): the self-host server downloads a Realm card by
 * its id, spools it under `save/.tmp`, reads it, and stores its assets, so the tab never fetches
 * realm.risuai.net and never holds a CharX or PNG file (a legacy JSON answer, a card without its
 * images, is passed to it whole as text). It is two steps, so that the questions the tab asks about
 * the card (its `lowLevelAccess`, an rcc card's password) come before anything is stored:
 *
 * 1. Prepare, `POST /api/import/realm` with `{ id }`: the server downloads and validates the file and
 *    reads the card's parts, writing nothing; it keeps the file staged and answers one NDJSON line, a
 *    `RealmPrepared` (the card's text, a CharX file's embedded `module.risum`, and the staged
 *    import's `token`), or one `{ error }` line. A legacy JSON answer is the whole import: its line
 *    has no token, and nothing is staged.
 * 2. Commit, `POST /api/import/realm/commit` with `{ token }`: the server stores the staged file's
 *    assets (and a PNG's trimmed image) and answers NDJSON: `{ done, total }` progress lines (asset
 *    chunks or entries stored), then one `RealmCommitted` line or one `{ error }` line. Or cancel,
 *    `POST /api/import/realm/cancel` with `{ token }`: the staged file is removed, nothing stored.
 *
 * A staged import that is neither committed nor cancelled is removed after `REALM_STAGED_TTL_MS`
 * (commit then answers 404 `REALM_IMPORT_EXPIRED`). The tab builds the character from the card it
 * read and the keys the commit answered (`downloadRisuHub` in `src/ts/characterCards.ts`).
 *
 * Realm answers one of three kinds, told apart by its `content-type`:
 *
 * - `application/charx` or `application/zip`: a CharX file, read by the CharX reader
 *   (`shared/charxImport.ts`) with the CharX import's entry rules.
 * - `image/png`: a PNG card, read by the server's PNG reader (`server/src/routes/importPng.ts`), the
 *   second reader of PNG cards beside the tab's `PngChunk.readGenerator`, with the same rules: every
 *   `tEXt` chunk is removed from the image, `chara-ext-asset_*` chunks are stored as assets, and the
 *   card is the `ccv3` chunk's text, else the `chara` chunk's.
 * - anything else: the legacy JSON answer (`{ card, img }`), passed through as text for the tab's hub
 *   import (its portrait and hub-mode assets are still fetched by the tab through `/hub-proxy`).
 */

import type { CharxImportFailure, CharxImportProgress } from "./charxImport.ts";

/** Prepare: download, validate, and stage (see the file comment). */
export const REALM_IMPORT_PATH = "/api/import/realm";
/** Commit a staged import: store its assets. */
export const REALM_COMMIT_PATH = "/api/import/realm/commit";
/** Cancel a staged import: remove its file. */
export const REALM_CANCEL_PATH = "/api/import/realm/cancel";

/** How long a staged import waits for its commit or cancel (from the prepare's answer). */
export const REALM_STAGED_TTL_MS = 10 * 60 * 1000;
/** How many staged imports may wait at once; a prepare past it is a 409 `REALM_TOO_MANY_STAGED`. */
export const MAX_REALM_STAGED = 4;
/** A staged import's token: a UUID. */
export const REALM_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The 404 `error` text of a commit whose staged import is gone (expired, cancelled, or committed). */
export const REALM_IMPORT_EXPIRED = "Import expired";
/** The 409 `error` text of a prepare while `MAX_REALM_STAGED` staged imports wait. */
export const REALM_TOO_MANY_STAGED = "Too many imports are waiting";

/** A Realm id: what the Realm list and `?realm=` links carry (UUIDs), kept URL-safe. */
export const REALM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The Realm download endpoint's origin; the server's default (tests replace it). */
export const REALM_ORIGIN = "https://realm.risuai.net";

/** The download URL of the card `id` under `origin` (the Realm API version is a request header). */
export function realmDownloadURL(id: string, origin: string = REALM_ORIGIN): string {
    return `${origin}/api/v1/download/dynamic/${encodeURIComponent(id)}?cors=true`;
}

/** The Realm API version the download asks for (the `x-risu-api-version` header). */
export const REALM_API_VERSION = "4";

/**
 * The 502 `error` text when the download itself failed (no answer in time, a refused redirect, a
 * broken body); a Realm answer other than 200 is a 502 with Realm's own text instead.
 */
export const REALM_DOWNLOAD_FAILED = "Realm download failed";

/**
 * The prepare line of a CharX download: the card entry's text (`card.json`, decoded as the CharX
 * import decodes it) and the embedded `module.risum`'s bytes as base64 (null without one), read by
 * the CharX import's entry rules (the last entry of a kind wins; one over the entry cap is skipped).
 */
export type RealmPreparedCharx = { kind: "charx"; token: string; card: string; moduleData: string | null };

/** The prepare line of a PNG download: the card's `tEXt` value as it is (base64 JSON, or an `rcc||` card). */
export type RealmPreparedPng = { kind: "png"; token: string; card: string };

/** The prepare line of a legacy JSON download: the answer's text (nothing is staged). */
export type RealmJsonResult = { kind: "json"; body: string };

export type RealmPrepared = RealmPreparedCharx | RealmPreparedPng | RealmJsonResult;

/** The commit line of a CharX download: each asset entry's name mapped to its stored key, and the excluded entries. */
export type RealmCommittedCharx = { kind: "charx"; assets: Record<string, string>; excluded: string[] };

/**
 * The commit line of a PNG download: the key the trimmed image (the PNG without its `tEXt` chunks) is
 * stored under, and each asset chunk's index (its key without `chara-ext-asset_:`/`chara-ext-asset_`)
 * mapped to the key its bytes are stored under.
 */
export type RealmCommittedPng = { kind: "png"; image: string; assets: Record<string, string> };

export type RealmCommitted = RealmCommittedCharx | RealmCommittedPng;

/** One line of the prepare's NDJSON answer: one prepared line or one failure. */
export type RealmPrepareLine = RealmPrepared | CharxImportFailure;

/** One line of the commit's NDJSON answer: progress lines, then one committed line or one failure. */
export type RealmCommitLine = CharxImportProgress | RealmCommitted | CharxImportFailure;
