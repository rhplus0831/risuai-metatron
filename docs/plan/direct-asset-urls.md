# Direct Asset URLs Plan

Status: drafted 2026-10-23 at `28e7fda88` and imported into `docs/plan/` on 2026-10-23 at
`832caccf0`, after the Per-Chat Send plan was archived. All 8 slices landed on `metatron` through the Combined Run index (`docs/plan/combined-run.md`, plan-runner) between 2026-10-23 and 2026-10-24, one cherry-picked commit each: DA0 (`81015f89d`), DA1 (`22f1da897`), DA2 (`2a7d338f8`), DA3 (`92c6d4b91`), DA4 (`560a3d86c`), DA5 (`52192c078`), DA6 (`c05c2bf88`), DA7 (`dd19f530b`). The run's final checks on `b60d8fff5` passed. The Server Thumbnails
plan runs after this one (owner decision 2026-10-23, see Not In This Plan). A Luna fan-out (7
workers) mapped the code at `28e7fda88`, and the session re-read the signing code, the key
store, `/api/read`, and the limiters. The source is the 2026-10-20 research pick
(`docs/research/pocketrisu-risubard-picks.md` §2.1, `docs/research/README.md`
PocketRisu/RisuBard decision 2). PocketRisu (`/home/codex/PocketRisu`) is a read-only
reference. Line numbers are approximate; the identifiers are the anchors. Re-verify each cited
location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent` (`--e2e` where it touches a screen an `e2e/` spec covers) and
the owning guide's focused checks, and updates the owning guide where it changes a
documented contract. Code comments and test titles describe behavior, not this plan
(`STRUCTURE.md` T5).

## Problem

A stored asset reaches the screen only through the tab's memory:

- `getFileSrc` (`src/ts/globalApi.svelte.ts` ~107-252) reads the bytes with `readAsset`.
  That is an authenticated `GET /api/read` with the hex key in a `file-path` header
  (`src/ts/storage/assetClient.ts` ~182-211). The server answers `application/octet-stream`
  with no cache header, Range, or ETag (`server/src/routes/storage.ts` ~272-319).
- With a working service worker, the page POSTs the bytes to `/sw/register/<hex>`, and the
  worker serves them from Cache Storage `risuCache` as `/sw/img/<hex>` (`public/sw.js` ~19-120).
  - Every entry is labeled `image/png` with `max-age=604800`. There is no Range support, and
    no eviction: the only mutation is `put`.
  - The worker never fetches the server, so the browser's HTTP cache is never used.
- Without a worker, the page makes `image/png` blob URLs. A plain `getFileSrc` read pins its
  source for the page (`globalApi.svelte.ts` ~125-137). The heap plan's D2b measured 40.5 MB
  for 51 files shown, never freed (archived README ~425-428).
- Inlay audio and video always go through typed object URLs that are never revoked
  (`src/ts/process/files/inlays.ts` ~530-558, `mediaObjectUrls`).
  - The reason is that rendered and cached HTML (`ChatBody.svelte` `lastParsed`, the parser's
    `fileSrcCache` ~445-455) keeps the URL strings.
  - The parser hard-codes `type="video/mp4"` and `type="audio/mpeg"`
    (`parser.svelte.ts` ~871-890).
  - The 2026-10-23 static audit's F1 and the archived audit's 3d record this.

Asset names are content-addressed by convention only:

- `saveAsset` names a file `assets/<sha256>.<ext>`, unless the caller passes a custom id or
  hashing throws (then a UUID) (`globalApi.svelte.ts` ~273-303).
- Inlays use `assets/inlay_<sha256>.<ext>` (`inlays.ts` ~314-337), and server imports use
  `assets/<sha256>.png` (`server/src/http/contentAsset.ts` ~8-41).
- `/api/write` and `/api/assets/write` overwrite any key without checking the bytes against the
  name (`storage.ts` ~389-540), and `GET /api/remove` deletes one (~321-357).

So a URL cannot be `immutable` just because its name looks like a hash.

Authentication cannot ride on a plain `<img src>`:

- Every request carries `risu-auth`. This is a fresh ES256 JWT: `iat`, `exp = iat + 300`, and
  the public JWK as `pub`, signed with the browser's non-extractable P-256 key
  (`src/ts/storage/serverAuth.ts` ~5-64).
- The key is kept in IndexedDB `DPoPDB`, store `node`, key `dpop` (`src/ts/util.ts`
  ~1142-1197). Despite the database name this is not DPoP: the token has no
  `htu`/`htm`/`jti`, so it is not bound to a method or URL, and the server keeps no replay
  cache.
- The server reads only the `risu-auth` header (`server/src/routes/auth.ts` ~44-121). The
  WebSocket routes also take it from the query string (`server/src/routes/events.ts`
  ~127-166). No production code reads or sets a cookie.

## Security Design

Assets are personal data on a server that may face a LAN, a reverse proxy, or a tunnel
(`server/src/listenConfig.ts` ~4-32, `server.sh` ~15-18). A direct URL must not widen who can
read them. What runs in the app origin today:

- Chat, background, and module HTML goes through DOMPurify with `<img src>`, CSS `url()`,
  `<style>`, and `<form>` kept (`parser.svelte.ts` ~62-160, ~994-1075). Bot HTML can
  reference any same-origin URL, but it runs no script.
- Custom CSS is injected verbatim (`src/ts/stores.svelte.ts` ~147-157). Custom GUI HTML runs
  through its own renderer (`Chat.svelte` ~1671-1802). Realm `additionalHTML` is inserted
  unsanitized (`RealmMain.svelte` ~119).
- Plugin v3 runs in a sandboxed iframe without `allow-same-origin`
  (`src/ts/plugins/apiV3/factory.ts` ~897-916) with `connect-src 'none'` and `img-src *`
  (~440-445). Its `nativeFetch` is executed by the parent page with `fetch(url, ...)` and no
  origin restriction (`v3.svelte.ts` ~1342-1388, `globalApi.svelte.ts` ~1024-1030).
- No top-level CSP exists (`index.html` ~22 is commented out).

Threats and how the design answers each:

| Threat                                                                                                                                                       | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Another site or device fetches or embeds an asset URL                                                                                                        | Every byte response requires `risu-auth`, as `/api/read` does today; the URL itself is no credential, so leaking it (exported HTML, CSS attribute selectors, Referer) grants nothing.                                                                                                                                                                                                                                                                                    |
| A plugin reads asset bytes through `nativeFetch` or an `<img>` in its iframe                                                                                 | The worker adds auth only for a page-controlled request whose `destination` is `image`, `audio`, `video`, `track`, `style`, or `font` (D5). `fetch()` has destination `""` and the parent's `nativeFetch` gets no auth. The opaque-origin iframe is not a client the worker controls, and `Cross-Origin-Resource-Policy: same-origin` blocks its loads, the HTTP cache included.                                                                                         |
| A stored SVG, HTML, or XML asset opened as a page (for example "open image in new tab") runs script in the app origin, where it can use the key in IndexedDB | Every asset response carries `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'` and `X-Content-Type-Options: nosniff`. Active types (`html`, `htm`, `xhtml`, `xml`, `js`, `mjs`) are sent as `application/octet-stream` with `Content-Disposition: attachment` (D6). The worker never signs a `document` request, but a cached response may still answer one, so the headers are what protect it. |
| An `immutable` URL whose bytes later change (overwrite, restore, a custom id)                                                                                | Only a name whose bytes the server has verified against the hash in the name gets `immutable`. Any other name gets `private, no-cache` with a validator (slice 2).                                                                                                                                                                                                                                                                                                       |
| Cross-site request forgery through the new route                                                                                                             | The route is a read: `GET`/`HEAD` with no side effects. No cookie is introduced, so no ambient credential exists.                                                                                                                                                                                                                                                                                                                                                        |
| Assets left in the browser's disk cache                                                                                                                      | `Cache-Control: private` keeps them out of shared caches. The browser profile keeps them, as `risuCache` does today: there is no logout (`serverAuth.ts`, `auth.ts`).                                                                                                                                                                                                                                                                                                    |

The HttpOnly cookie design PocketRisu uses (`risu-session`, `SameSite=Strict`, `Path=/`, no
`Secure`, seven days, never revoked; `server/node/server.cjs` ~1964-2010, ~3731-3800) was
considered and not chosen as the default (D1):

- Cookies ignore ports. Another service on the same host receives the cookie and can replay
  it.
- Same-site rules let other ports and subdomains send it.
- It adds a second credential with its own issuance, renewal, and revocation.
- The parent's plugin `fetch` would carry it.

## Approach

Assets get a direct, authenticated, cacheable URL `/api/asset/<hex(key)>`. The service worker
attaches the existing `risu-auth` token to the page's subresource requests for it. The
browser's HTTP cache then holds the bytes instead of the tab.

- **Server** (`server/src/routes/storage.ts`): `GET`/`HEAD /api/asset/:hex` uses the same key
  resolution as `/api/read` (`decodeKeyHeader`, `resolveStorageKey`) and the storage limiter.
  It sends:
  - `Content-Type` from the extension;
  - single-range `Range` (206/416);
  - a validator and 304;
  - the security headers above;
  - `immutable` only for verified content names.
- **Service worker** (`public/sw.js`): a page request to `/api/asset/*` with an allowed
  destination is re-issued from the worker as a same-origin `fetch` with `risu-auth` added and
  any `Range` copied, with the default cache mode.
  - The worker signs the same JWT `serverAuth.ts` signs: it reads `DPoPDB`/`node`/`dpop` and
    calls `crypto.subtle.sign`.
  - It reuses one token for up to four minutes, as `resourceClient.ts` (~304-355) does.
  - `/sw/init` answers `v3` with a capability flag, so the page knows the worker can do this.
- **Client**: `getFileSrc` returns `/api/asset/<hex>` when the worker reports the capability
  and controls the page. It reads no bytes, creates no blob, registers nothing, and pins
  nothing. Every other case keeps today's path.
  - Inlay audio and video use the same URL with their real MIME, so `mediaObjectUrls` is left
    only for the fallback.
  - `fileSrcCache` and cached HTML keep stable strings that never need revoking.
- **Fallback** (no worker, or a page the worker does not control): unchanged. These are an
  insecure origin (no login is possible there anyway, since `crypto.subtle` needs a secure
  context), a browser without workers, or the first load before `clients.claim`.

## Order

0 → 1 → 2 → 3 → 4 → (5, 6) → 7.

- Slice 0 is a browser probe. It decides whether the worker mechanics (D1 (a)) hold before any
  product code. If they fail, D1 falls back to (b), and slices 3–4 change shape.
- 1 and 2 are server-only and usable by `authFetch` callers on their own; 2 adds `immutable` on
  top of 1.
- 3 (worker) needs 1. 4 (client) needs 3.
- 5 (inlay media) and 6 (`risuCache` retirement) need 4. They share no file, so they run in
  parallel.
- 7 is docs, the e2e specs, and the measurement, last.
- Coordination: small-fixes slice 4 (`small-fixes.md`, static file caching)
  edits `server/src/app.ts` near the static handler, and slice 1 may register its route there.
  Land them one after the other.

## Slice 0. Probe the browser mechanics (_small_, `build-test-platforms.md`)

- `util/playwright/probeDirectAssets.mjs`: a standalone script with its own tiny HTTP server
  and a test worker, not the app.
- In Chromium (and Firefox when installed), check each of these and record pass/fail in the
  plan's Status and the commit message:
  - (a) A worker in a secure context (`localhost`) reads a non-extractable ECDSA key pair
    stored by the page in IndexedDB and signs with it.
  - (b) A worker `fetch` carrying a custom header, answered `Cache-Control: private,
max-age=31536000, immutable`, is served from the HTTP cache on the next page load with no
    server request (count requests on the server).
  - (c) A `<video>` whose `Range` requests go through the worker as same-origin fetches gets
    206 answers, plays, and seeks.
  - (d) A cached SVG with script, opened by top-level navigation under the CSP sandbox header,
    runs no script.
  - (e) A sandboxed srcdoc iframe without `allow-same-origin` loading the URL is not
    intercepted, and is blocked by `Cross-Origin-Resource-Policy: same-origin` even after the
    page cached it.
- Test: the script exits non-zero on any failed check. It is not in the gate.

## Slice 1. The authenticated asset route (_hard_, `self-host-server.md`)

- `storage.ts`: `GET`/`HEAD /api/asset/:hex` with the storage limiter and `auth.checkAuth`.
  - The key is the path segment, decoded as `decodeKeyHeader` decodes `file-path`.
  - A missing, non-file, or out-of-namespace key answers 404 with `no-store`. `/api/read`'s
    empty 200 is an old-client contract that the new route does not copy.
  - Read size and bytes from one handle, as `/api/read` does (~301-314).
- `Content-Type` from a table in `shared/` (for example `shared/assetMime.ts`): `png`, `jpg`,
  `jpeg`, `webp`, `gif`, `avif`, `svg`, `mp3`, `ogg`, `wav`, `m4a`, `mp4`, `webm`, `woff2`,
  `ttf`, `otf`, `json`; `application/octet-stream` otherwise. The parser (slice 5) and the
  inlay client's `mimeOf` (`inlays.ts` ~164-176) use the same table.
- `Range`: one `bytes=` range gives 206 with `Content-Range`; an unsatisfiable range gives 416;
  several ranges are ignored (200). Every answer carries `Accept-Ranges: bytes`.
- Validator: a weak `ETag` from size and mtime, and `If-None-Match` answers 304. Cache-Control
  is `private, no-cache` for every name in this slice.
- Security headers on every answer, 304 and errors included: the CSP and `nosniff`.
  - `Cross-Origin-Resource-Policy: same-origin` and `Content-Disposition: inline`.
  - For the active types, `attachment` and `application/octet-stream` instead (D6).
- `shared/diagnostics.ts` `ROUTE_TEMPLATES`: add `/api/asset/*`, as was done when the message
  search route was added. The diagnostics must never record the hex key.
- `self-host-server.md`: the route table (~152-164), the asset headers, and a Known Hazard for
  any limit kept.
- Test, in `server/src/tests/assets.test.ts` or a new `assetRoute.test.ts`:
  - 401 without a token, and an image's bytes and type with one.
  - `HEAD` returns no body.
  - 206 for a range, 416 past the end, 200 for several ranges.
  - 304 for a matching `If-None-Match`.
  - 404 with `no-store` for a missing key.
  - An `.svg` carries the CSP sandbox and an `.html` is `attachment` + octet-stream.
  - CORP and `nosniff` on every status.
  - An atomic replace during a read leaves size and bytes consistent (as `app.test.ts`
    ~647-664 does for `/api/read`).

## Slice 2. Verified content names become immutable (_hard_, `self-host-server.md`)

Depends: 1.

- A content name is `assets/<64 lowercase hex>.<ext>` or `assets/inlay_<64 hex>.<ext>`. Its
  bytes are verified when their SHA-256 equals the hex in the name.
- `server/src/http/assetVerification.ts` (new): an in-memory map from a name to
  `{ size, mtimeMs, ino, ok }`.
  - Writes record verification:
    - `/api/write` and `/api/assets/write` hash while they stage (~389-540);
    - `contentAsset.ts` already hashes;
    - the backup restore's links (`server/src/routes/backups.ts` ~396-430) record theirs.
  - A mismatched write is accepted and recorded `ok: false` (D3).
  - The route looks the name up by the current stat. With no matching entry it answers
    `private, no-cache` this time and queues a background hash: one at a time, a bounded
    queue, and a skipped entry is hashed again on its next request.
  - With an `ok` entry: `Cache-Control: private, max-age=31536000, immutable` and a strong
    `ETag: "sha256-<hex>"`.
  - A 304 carries the same Cache-Control, so a response first cached as `no-cache` turns
    immutable on its next revalidation.
- Names that are not content names (custom ids, UUID fallbacks) stay `private, no-cache`
  forever.
- `GET /api/remove` drops the entry. Deleting the bytes never invalidates a browser's copy;
  only the same bytes can ever come back under that name.
- `self-host-server.md`: the content-name invariant and its limits:
  - verification is in memory and starts over at restart;
  - a file changed on disk outside the server is caught by its stat changing.
- Test:
  - A write of matching bytes makes the next GET immutable with the strong ETag.
  - Mismatched bytes stay `no-cache`.
  - A file never written through the server is `no-cache` first and immutable after the
    background hash.
  - A replaced file (new mtime) is `no-cache` until it is verified again.
  - A custom-id name is never immutable.
  - A 304 on a verified name carries `immutable`.
  - The queue hashes one file at a time and drops nothing it was asked for.

## Slice 3. The service worker authenticates asset requests (_hard_, `build-test-platforms.md`)

Depends: 1, and slice 0's (a)–(c) passing.

- `public/sw.js`:
  - Intercept `GET`/`HEAD` for same-origin `/api/asset/*` only when `event.request.destination`
    is in the allowlist (D5) and the request has a client id. Every other request falls
    through untouched.
  - Re-issue it as `fetch(url, { method, headers: { "risu-auth": token, range? }, mode:
"same-origin", credentials: "omit", cache: "default" })`.
  - Media requests arrive as `no-cors`, whose header guard forbids `risu-auth`, so the worker
    builds a new request rather than cloning.
- Token:
  - Open `DPoPDB` version 1 and read store `node`, key `dpop`, exactly as `util.ts` does,
    without creating the store.
  - Sign `{ alg: "ES256", typ: "JWT" }` / `{ iat, exp: iat + 300, pub }` with
    `crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ...)`, base64url as
    `serverAuth.ts` does.
  - Reuse the token until 60 s before its expiry. Read the key again on a 401, then retry once.
  - With no key, pass the request through unauthenticated (it answers 401).
- `/sw/init` answers `v3` and `{ directAssets: true }` (the client's probe is in
  `src/ts/bootstrap.ts` ~304-343).
- The signing code exists twice (page and worker). A test signs with the worker's code and
  verifies with the server's `auth.ts` (D7).
- `build-test-platforms.md`: the worker's asset route and the probe.
- Test, in `src/ts/sw.share.test.ts` style (`runInNewContext` over `public/sw.js`):
  - An allowed destination gets `risu-auth` and a copied `Range`.
  - The `""` (fetch), `document`, and `iframe` destinations pass through unsigned.
  - A token is reused within its window and re-signed after.
  - A 401 re-reads the key and retries once.
  - A missing key passes through.
  - A cross-origin URL passes through.
- Server test: a token made by the worker's code is accepted by `checkAuth` (fake IndexedDB
  with a real WebCrypto key).

## Slice 4. getFileSrc returns direct URLs (_hard_, `global-api.md`)

Depends: 3.

- `globalApi.svelte.ts`:
  - Direct mode when `/sw/init` reported `directAssets` and `navigator.serviceWorker.controller`
    is set at the call. The boot probe sets it beside `setUsingSw` (`bootstrap.ts` ~80-90).
  - In direct mode, `getFileSrc` and `holdFileSrc` return `/api/asset/<hex>` at once, with no
    read, no `risuCache` check, and no register. The hold's release does nothing. Nothing is
    pinned or revoked.
  - A page that loses its controller (worker update, unregister) uses the fallback for new
    calls. URLs already handed out still load through the HTTP cache or answer 401. The
    browser check in slice 7 covers this.
- Screenshots: `html-to-image` (`DefaultChatScreen.svelte` ~772-827) inlines images with
  `fetch()`, which the worker does not sign.
  - Pass `fetchRequestInit` with a fresh `risu-auth` from `authFetch`'s token, or inline the
    chat's asset URLs through `authFetch` before capture.
  - Check the copy-to-HTML icon path (`Chat.svelte` ~1187-1317) the same way.
- Check every `getFileSrc` consumer the fan-out listed (avatars and `getCharImage`, emotions,
  backgrounds, parser assets, `ChatBody` late replacement, `LazyFileSrc`, `LazyCharImage`).
  Each must take a same-origin path where it took `blob:` or `/sw/img/` before, including the
  `startsWith` lists in `Chat.svelte` ~1191-1200.
- `global-api.md` (~24-33): the two modes and when each applies.
- Test, in `src/ts/globalApiRetention.test.ts`:
  - Direct mode returns `/api/asset/<hex>` with no `readAsset` call and no `/sw/register`
    request.
  - A hold and its release create and revoke nothing.
  - Without a controller, today's path is used.
  - The fallback tests stay as they are.
- `e2e/storedFileSrc.spec.ts`: a stored image shows from `/api/asset/`, and a reload loads it
  with no server request (count requests).

## Slice 5. Inlay media and parser types (_small_, `cbs-rendering.md`)

Depends: 4.

- `parser.svelte.ts` `parseInlayAssets` (~859-890):
  - In direct mode, audio and video use `/api/asset/<hex(media.asset)>`, not
    `getInlayObjectUrl`.
  - `type` comes from the shared MIME table (slice 1) for the inlay's `ext`, not the
    hard-coded `video/mp4` and `audio/mpeg`.
  - Images already go through `getFileSrc`.
- `inlays.ts` `getInlayObjectUrl`/`mediaObjectUrls` (~530-558) stay for the fallback only.
  Update the comment there.
- `cbs-rendering.md` and `chat-pipeline.md` (inlays) describe the two modes.
- Test, in `parser` tests with `getFileSrc` and the mode stubbed:
  - Direct mode emits the asset URL and the real type for `.webm`, `.ogg`, and `.m4a`.
  - The fallback still emits an object URL.
- A browser check (slice 7) plays and seeks a video inlay.

## Slice 6. Retire asset entries in risuCache (_small_, `build-test-platforms.md`)

Depends: 4.

- On activation of the `v3` worker, delete the `/sw/img/*` entries from `risuCache` and keep
  `/sw/share/*` (D4).
- `/sw/register` and `/sw/check` stay for a tab still running the old client. That tab gets
  the fallback once the entries are gone, because its `/sw/img` answers miss.
- `diagnostics.ts` ~318 keeps `/sw/img/*` as long as the handler exists.
- `server/src/tests/fixtures/transform/display-trigger-assets.json` and
  `e2e/transformGolden.spec.ts` (~501-565): update the golden output to the URL each mode
  produces.
- Test: the worker test's activation deletes asset entries only; a share entry survives.

## Slice 7. Docs, browser checks, measurement (_small_, `global-api.md`)

Depends: 5, 6.

- Rerun `util/playwright/measureFileSources.mjs` in worker mode and record the result. The
  D2b baseline was 40.5 MB of page Blobs without the worker, and 2 MB of audio object URLs
  with it. Expected now: none in direct mode.
- Browser checks to record:
  - avatars, emotions, a background, a module asset, and image, audio, and video inlays shown;
  - video seek;
  - a worker update while a chat is open;
  - "open image in new tab" on an SVG asset (no script);
  - a plugin `<img>` of an asset (blocked);
  - a screenshot and a copy-to-HTML.
- Guides:
  - `global-api.md`, `self-host-server.md`, `cbs-rendering.md`, `build-test-platforms.md`;
  - `docs/archived-plan/README.md` remaining follow-ups: D2b, 3d, and the service worker's
    MIME/Range item, marked resolved for worker mode.
  - `docs/research/README.md` PocketRisu/RisuBard decision 2: decided.

## Decisions

The runner takes each default unless the user overrides it.

- D1. How a direct URL authenticates. Options:
  - (a) The service worker signs `risu-auth` for allowed subresource destinations; no new
    credential.
  - (b) An HttpOnly cookie, as in PocketRisu:
    - `__Host-risu-asset`, `Secure`, `SameSite=Strict`, `Path=/`;
    - issued by an authenticated `POST`, bound server-side to the registered key's hash, with
      a lifetime and renewal;
    - the route rejects `Sec-Fetch-Dest: empty` and cross-site `Sec-Fetch-Site`.
  - (c) Signed capability URLs (`?sig=HMAC(key)`): no auth at load, but the URL is the
    credential, and bot CSS can exfiltrate attribute values.

  Default (a) if slice 0 passes. (b) also covers browsers without a worker, at the cost of
  the risks in Security Design.

- D2. `max-age` for verified names (slice 2). Options: (a) one year + `immutable`; (b)
  `no-cache` with the strong ETag (one 304 round trip per load). Default (a).
- D3. A write whose bytes do not match its content name (slice 2). Options: (a) accept, never
  immutable; (b) refuse with 400. Default (a): no writer is known to do this, and a refusal
  could break an old client or an import mid-way.
- D4. Old `risuCache` asset entries (slice 6). Options: (a) delete at the `v3` worker's
  activation; (b) keep until the browser evicts them. Default (a).
- D5. Destinations the worker signs (slice 3): `image`, `audio`, `video`, `track`, `style`,
  `font`. Not `""` (fetch, XHR, the plugin bridge), `document`, `iframe`, `worker`, or
  `object`. Default as listed.
- D6. Active types (slice 1). Options:
  - (a) `html`/`htm`/`xhtml`/`xml`/`js`/`mjs` as `attachment` + octet-stream, and `svg` inline
    as `image/svg+xml` under the CSP sandbox;
  - (b) `svg` as `attachment` too. `<img>` ignores `Content-Disposition`, so SVG assets still
    display; only opening one as a page changes (it downloads instead).

  Default (a).

- D7. Signing code shared between page and worker (slice 3). Options: (a) a hand copy in
  `public/sw.js`, with a parity test; (b) build `sw.js` from a module with Vite. Default (a):
  the worker is hand-written today and is loaded unbundled.

## Not In This Plan

- Server thumbnails (Haejeok B1, PocketRisu `inlay_thumb`): a later `?w=` variant of this
  route, in its own plan. The Server Thumbnails plan (`server-thumbnails.md`) runs after this
  one (owner decision 2026-10-23) and re-plans its route and client slices onto this route.
- Asset garbage collection and an orphan sweep (RisuNest item 7). Deleting is already allowed
  and does not break immutability (slice 2).
- A logout or device revocation (none exists).
  - When one is added, it should clear the HTTP cache for the origin (`Clear-Site-Data:
"cache"`).
  - It should also clear the boot cache: `clearBootCache` has no caller
    (`src/ts/storage/bootCache.ts` ~748-754).
- The fallback's own leftovers: page-lifetime blobs without a worker and `mediaObjectUrls`.
  They stay as accepted in D2b, now limited to browsers without a worker.
- HTTP compression of asset responses (images and media are already compressed).
- `/hub-proxy/*` passing upstream headers without auth (`server/src/routes/proxy.ts`
  ~373-425): a separate review item.

## Open Questions

- Does Safari (iOS Home Screen app included) honor `immutable` for a worker-issued fetch, and
  play a ranged video through the worker? Slice 0 runs Chromium and Firefox only. Record a
  manual check before slice 4 lands, if a device is available.
- Should the route also accept `risu-auth` from the query string, as the sockets do, for a
  future `<a download>`? Not planned. It would make URLs credentials again.
