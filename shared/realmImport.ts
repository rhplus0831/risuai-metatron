/**
 * The Realm download (`POST /api/import/realm`, `server/src/routes/importRealm.ts`): the self-host
 * server downloads a Realm card by its id, spools it under `save/.tmp`, reads it, and stores its
 * assets, so the tab never fetches realm.risuai.net and never holds a CharX or PNG file (a legacy
 * JSON answer, a card without its images, is passed to it whole as text). The answer is NDJSON:
 * `{ done, total }` progress lines (asset chunks or entries stored), then one `RealmImportResult`
 * line or one `{ error }` line. The tab builds the character from the result
 * (`downloadRisuHub` in `src/ts/characterCards.ts`).
 *
 * Realm answers one of three kinds, told apart by its `content-type`:
 *
 * - `application/charx` or `application/zip`: a CharX file, read by the CharX reader
 *   (`shared/charxImport.ts`); the result is the CharX import's result line with `kind: "charx"`.
 * - `image/png`: a PNG card, read by the server's PNG reader (`server/src/routes/importPng.ts`), the
 *   second reader of PNG cards beside the tab's `PngChunk.readGenerator`, with the same rules: every
 *   `tEXt` chunk is removed from the image, `chara-ext-asset_*` chunks are stored as assets, and the
 *   card is the `ccv3` chunk's text, else the `chara` chunk's.
 * - anything else: the legacy JSON answer (`{ card, img }`), passed through as text for the tab's hub
 *   import (its portrait and hub-mode assets are still fetched by the tab through `/hub-proxy`).
 */

import type { CharxImportFailure, CharxImportProgress, CharxImportResult } from "./charxImport.ts";

export const REALM_IMPORT_PATH = "/api/import/realm";

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

/** The result line of a CharX download: the CharX import's result. */
export type RealmCharxResult = CharxImportResult & { kind: "charx" };

/**
 * The result line of a PNG download: the card's `tEXt` value as it is (base64 JSON, or an `rcc||`
 * card), null without one; the key the trimmed image (the PNG without its `tEXt` chunks) is stored
 * under; and each asset chunk's index (its key without `chara-ext-asset_:`/`chara-ext-asset_`) mapped
 * to the key its bytes are stored under.
 */
export type RealmPngResult = {
    kind: "png";
    card: string | null;
    image: string;
    assets: Record<string, string>;
};

/** The result line of a legacy JSON download: the answer's text. */
export type RealmJsonResult = { kind: "json"; body: string };

export type RealmImportResult = RealmCharxResult | RealmPngResult | RealmJsonResult;

/** One line of the route's NDJSON answer: progress lines, then one result or one failure. */
export type RealmImportLine = CharxImportProgress | RealmImportResult | CharxImportFailure;
