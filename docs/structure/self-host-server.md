# Self-Host Server (Hono on Node), Docker

## Scope

- Owns:
  - The process shell of `server/src/**`, the Hono self-host server on Node (`@hono/node-server`): startup and shutdown,
    route assembly, static `dist`, auth, asset storage and thumbnails, the reverse proxy, the hub proxy, and Web Push.
  - Local TLS certificates.
  - Docker packaging.
  - The launcher scripts.
  - The client/server contract of the above, seen from the server side.
- Neighbors: [server resources](server-resources.md) owns the resource store, chats, checkpoints, snapshots, backups,
  file imports, and their routes; [server generation and live channels](server-generation.md) owns jobs, transforms, the
  LLM and token routes, and the live-update feed.
- Paths: `server/{src/**,tsconfig.json,ssl/*}`, `Dockerfile`, `.dockerignore`, `server.sh`, `server.bat`.
  Domain-specific runtime semantics stay with their owner guides; request history and diagnostics have a dedicated
  [owner](diagnostics.md).
- Client counterparts, owned by other guides:
  - `src/ts/storage/serverAuth.ts` → `persistence.md`; `src/ts/storage/assetClient.ts` → `global-api.md`.
  - `globalApi.svelte.ts` `fetchNative` → `global-api.md`.
  - `characterCards.ts` `hubURL` → `characters-modules.md`.

## Files

The server is TypeScript run directly by Node's type stripping: `pnpm run server` runs `node server/src/main.ts` on Node
`>=24`; there is no server build step. `server/tsconfig.json` strictly checks the server and its imports from `shared/`.
Routes, data, HTTP helpers, jobs, prompt processing, and tests live under `server/src/`.

### Entrypoints and configuration

- `main.ts` starts HTTP or HTTPS, installs WebSocket upgrades, starts background tasks, and drains shutdown. It passes
  `TRUST_PROXY` and sets a four-hour `REQUEST_TIMEOUT_MS`.
- `listenConfig.ts` parses bind, storage, and development-auth settings: `PORT` (default 6001), `RISU_HOST`,
  `RISU_SAVE_DIR`, and `RISU_AGENT_DEV_AUTH_BYPASS`. Unset `RISU_HOST` listens on every interface, and the auth bypass
  accepts `TRUE`/`1` only with a numeric loopback address (`127.0.0.0/8` or `::1`, without brackets).
  `parsePasswordSeed` trims and validates a 64-character SHA-256 hex string.
- `app.ts` assembles `createServerContext`, route registration, state, and lifecycle. It and its route factories consume
  the variables below; a value one of them cannot parse stops the start, with the variable's name.
- `RISU_PASSWORD_SHA256`; `RISU_MAX_IMPORT_BYTES` ([backup routes](server-resources.md#backup-routes));
  `RISU_MAX_UPSTREAM_DB_BYTES` ([upstream backups](server-resources.md#upstream-backups));
  `RISU_UPSTREAM_IMPORT_HEAP_MB`, `RISU_UPSTREAM_EXPORT_HEAP_MB`, and `RISU_RESTORE_HEAP_MB`
  ([heap limits](server-resources.md#limitations)); `RISU_SQLITE_SYNCHRONOUS`
  ([store connection](server-resources.md#store-connection)); and `RISU_REQUEST_HISTORY_MAX_BYTES`,
  `RISU_DIAGNOSTICS_DIR`, and `RISU_DIAGNOSTICS_MAX_BYTES` ([diagnostics](diagnostics.md)).

### Services and helpers

- `push/pushService.ts` handles Web Push. Each completion goes to every subscription with `TTL` 1 h, `urgency: "high"`,
  and the chat's tag hash as the RFC 8030 `topic`, so a push service replaces an undelivered completion only with a
  later one of the same chat; a tag without a valid hash gets no topic. Each outcome, with the job id the runner passes
  beside the notification, is a content-free `push` diagnostic event ([diagnostics](diagnostics.md)).
- `data/orderedWriter.ts` `createOrderedWriter` schedules the auxiliary files' writes for the auth store, the journal,
  and the push service: operations in FIFO order per key, at most four at once across keys, keys served in turn, one
  instance per context. It knows nothing about files, and each consumer keeps its own file code.
- `data/durableWrite.ts` `writeFileDurable` (`writeFileDurableSync` at creation) writes the auth password and known-key
  files and the push subscriptions through a flushed temporary file renamed into place.
- `http/{body,rateLimit,clientIp,compressedJson,staticCache,assetVerification,assetThumbnails}.ts` cover request limits,
  client IPs, caching, and asset delivery; `compressedJson` answers the
  [resource reads](server-resources.md#resource-routes). Thumbnail cache publication, removal, and stale-entry sweeps
  synchronize per key directory. See [global API](global-api.md) for the tab's transport and fetch policy.
- `diagnostics/` owns request history, diagnostic journals, reports, and support shares ([diagnostics](diagnostics.md)).
- Packaging: `server/ssl/` generates local certificates; `Dockerfile`, `.dockerignore`, `server.sh`, and `server.bat`
  define deployment and launch behavior.

### Routes

`app.ts` is the registration map of the server's HTTP and WebSocket surface. Check it and the named route module before
changing a path or its admission policy. Routing is non-strict (a trailing slash matches). Registration order in
`createServerContext`:

1. `onError`: `HTTPException` responses pass through; maintenance and a closed resource store answer 503 with
   `Retry-After`; other errors are a 500 `Internal Server Error`. Shutdown admission middleware then runs before body
   parsing:
   - It tracks resource handlers (`/api/resources`, `/api/llm-secrets`, `/api/chats/search`, `/api/memory/tasks`,
     `/api/memory/structured`, and `/api/chat-checkpoints`) and the auth and push writes (`POST /api/login`,
     `POST /api/set_password`, `PUT` and `DELETE /api/push/subscription`).
   - During shutdown it refuses new resource, message search, credential, backup, module import, CharX import, Realm
     import, token, request history, and diagnostics requests and those auth and push writes with 503, and adds
     `Connection: close` to every response.
   - Every request history, diagnostics, memory task, token, and chat checkpoint answer gets `Cache-Control: no-store`
     there, so a 429 or 413 carries it too.
2. `limitedBody` is the 100 MiB global cap (413 `{error:"Request body too large"}`); disk-spooled imports and routes
   with their own caps skip it.
   - Disk-spooled: backup import, upstream backup prepare, module import, and CharX import.
   - Per-route cap owners: [resources](server-resources.md#files), [generation](server-generation.md#files),
     [storage](#storage-routes), [auth](#auth-routes), [push](#push-routes), and
     [diagnostics](#request-history-and-diagnostics-routes).
   - Login, crypto, and password setup read before authentication and cap bodies at 16 KiB. The shared helper is
     `server/src/routes/limitedBody.ts`; chat checkpoints keep a separate `hono/body-limit` wrapper after auth.
   - Over-cap requests answer 413; a stream failure under the cap answers 400, never the app's 500
     ([Request bodies](#request-bodies)).
3. `GET /` and `GET /index.html` (no auth, no limiter; one shared handler, with `no-cache`, a weak size/mtime ETag,
   `Last-Modified`, and conditional 304 responses), then the same handler for the client's screen routes: a `GET *`
   handler serves it when `isClientRoutePath` (`shared/routes.ts`: first segment `chat`, `playground`, `realm`,
   `characters`, or `settings`) matches and passes every other path on ([URL routes](app-shell.md)).
   - It serves `dist/index.html` with `globalThis.__NODE__ = true` injected after the `<head>` tag. The same open handle
     supplies stat and text, and a missing `<head>` still throws before a conditional answer.
4. `createStaticCache` (`server/src/http/staticCache.ts`) checks regular files before `serveStatic` handles every other
   GET/HEAD of `dist/*` (no auth, no limiter):
   - `/assets/*` gets `public, max-age=31536000, immutable`; all other files (including `sw.js` and `manifest.json`) get
     `no-cache`.
   - For `.js`, `.mjs`, `.css`, `.json`, `.svg`, and `.wasm`, it negotiates fresh regular `.br` and `.gz` siblings using
     `Accept-Encoding` qualities (case-insensitive tokens, explicit exclusions, and wildcard; ties prefer Brotli, gzip,
     then identity). A missing header uses identity; missing, stale, or unacceptable siblings fall back to another
     acceptable representation or identity.
   - Compressed responses stream the sibling with its own length, `Content-Encoding`, the original file's MIME type, and
     a weak size/mtime ETag that includes the encoding. Each representation has its own ETag and `Last-Modified`; all
     compressible-file responses, including identity and 304, carry `Vary: Accept-Encoding`.
   - Matching `If-None-Match` for the selected representation (weak comparison; `*` only as the whole field) answers a
     bodyless 304; only when that header is absent, a parseable `If-Modified-Since` at or after mtime floored to whole
     seconds also answers 304.
   - Requests carrying `Range` or `If-Range` always use identity through `serveStatic`. `If-Range` permits Range only
     with a matching strong ETag or the exact `Last-Modified` date; weak tags, stale validators, and invalid values
     discard Range and serve the full 200.
   - HTML, including the injected index path, is never negotiated. Missing or rejected paths pass on without cache
     headers.
5. The route families, each documented in one place:
   - This guide: [proxy](#proxy-routes), [push](#push-routes),
     [request history and diagnostics](#request-history-and-diagnostics-routes), [auth](#auth-routes), and
     [storage](#storage-routes).
   - [Server resources](server-resources.md#files): `/api/resources*`, `/api/llm-secrets/*`, `/api/chats/search`,
     `/api/chat-checkpoints*`, `/api/backups*`, and `/api/import/*`.
   - [Server generation](server-generation.md#files): `/api/generations*`, `/api/transform*`, `/api/translate/message`,
     `/api/memory/tasks*`, `/api/llm/*`, `/api/tokens/*`, and `/api/events/ws`.
   - [Structured memory](structured-memory/records.md#the-read-routes): `/api/memory/structured/*`.

### Rate limits

`app.ts` builds four buckets, each keyed by client IP. A WebSocket upgrade has no HTTP limiter.

- The authenticated limiter, 2000/min: the proxy, resource, and job routes and every other route not named below.
- The storage limiter, 2000/min, with its own bucket so an asset burst (a module import or export) cannot starve
  resource sync: the [storage routes](#storage-routes).
- The auth limiter, 2000/min: `/api/test_auth` and `/api/crypto` share it.
- The login limiter, 10 per 30 s: `/api/login` and `/api/set_password` share it.

### Proxy routes

`routes/proxy.ts`, all on the authenticated limiter.

- `GET`/`POST /proxy`, `/proxy2`: `checkProxyAuth` (stored password in `risu-auth`, or a registered ES256 JWT).
  Arbitrary reverse proxy (`risu-url`, `risu-header`); with `risu-aux-op`, JWT only and one auxiliary operation
  (`server/src/llm/auxOps.ts`, [LLM requests](llm-requests.md)).
- `GET /hub-proxy/*`: no auth. Proxies to `https://sv.risuai.xyz` only (path and query after `/hub-proxy`); one redirect
  within that origin is followed, any other redirect is answered to the browser.

### Push routes

`routes/push.ts`: JWT, authenticated limiter, no epoch.

- `GET /api/push/key`: `{ publicKey }`: the VAPID public key, null while push is off on the server.
- `PUT /api/push/subscription`: body `{ subscription }` (`PushSubscription.toJSON()`, 16 KiB cap): 204; an unchanged
  healthy registration refreshed within 24 h answers without writing; 400 for an invalid one or an endpoint outside the
  allowed push services; 503 while push is off; 500 when the file could not be written.
- `DELETE /api/push/subscription`: body `{ endpoint }` (16 KiB cap): 204, also when it was not registered; 500 when the
  file could not be written.

### Request history and diagnostics routes

JWT, authenticated limiter, `no-store`; the [history, reports, and support-share contract](diagnostics.md#files) belongs
to diagnostics. `PUT /api/request-history/share` caps its body at 4 KiB and `POST /api/diagnostics/report` at 1 MiB,
after authentication.

- `GET /api/request-history?cursor&limit&…`, `GET /api/request-history/:id`, `DELETE /api/request-history`.
- `PUT /api/request-history/share`, `GET /api/request-history/shares`.
- `GET /api/diagnostics`, `POST /api/diagnostics/report`.

### Auth routes

`routes/auth.ts`.

- `GET /api/test_auth`: no auth, auth limiter. Returns `unset`, `incorrect`, or `success`.
- `POST /api/login`: password digest, login limiter. Registers a public-key hash.
- `POST /api/crypto`: **no auth**, auth limiter. SHA-256 of `body.data` (text/plain).
- `POST /api/set_password`: **no auth**, only works while unset; login limiter. First-run password setup.

### Storage routes

`routes/storage.ts`: `checkAuth` (JWT), storage limiter.

- `GET /api/read`, `/api/remove`, `/api/list`: storage. The `file-path` header is the hex UTF-8 key; `remove` takes
  `$$`-joined hex keys and validates every segment before deleting; no client calls it.
- `GET`/`HEAD /api/asset/*`: stored asset bytes; the path suffix is the hex UTF-8 key; extension-based MIME, single byte
  range (206/416), conditional ETag (304), no body for HEAD; 401 for a missing or rejected JWT, 404 for a missing or
  unsupported key. `?w=256` or `?w=512` selects the asset's WebP thumbnail, or a 307 to the original; any other, empty,
  or repeated `w` is 400.
- `POST /api/write`: storage write, raw body bytes.
- `POST /api/assets/write`: batch write (`shared/assetBatch.ts`): raw body of archive-framed records named by logical
  key, each staged, then renamed into place under the gate (overwrites); `{ success: true, written }`; 400
  `Invaild Path` + `index` or `Invalid asset batch`, 503, 500, each after the body is read.
- `POST /api/assets/read`: batch read: body `{ keys }` (1-2000); a chunked `no-store` octet stream of one record per
  key, in order, duplicates kept (zero-length for a missing file, symlink, non-regular file, or key with no storage
  location); 400.
- `POST /api/assets/missing`: `checkAuth` before body read. Verified presence: body `{ names }` (1-512, 64 KiB cap);
  `{ missing }` holds each unverified name once in first-asked order; non-canonical, unresolvable, absent, empty,
  corrupt, or over-budget files count as missing; `no-store`; 400/413.

### Asset responses

- `/api/asset/*` answers with
  `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'`,
  `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Accept-Ranges: bytes`, and
  `Content-Disposition: inline`, including errors and 304s.
- Byte responses and 304s use the extension's MIME from `shared/assetMime.ts`, including `flac` as `audio/flac` and
  `mkv` as `video/x-matroska` (unknown types: `application/octet-stream`); `html`, `htm`, `xhtml`, `xml`, `js`, and
  `mjs` use `attachment` and `application/octet-stream`, while SVG stays inline under the CSP sandbox.
- Successful responses and 304s are `Cache-Control: private, no-cache` with a weak ETag unless the content name is
  verified against the stat of the handle supplying the bytes. Verified names use
  `Cache-Control: private, max-age=31536000, immutable` and the strong ETag `"sha256-<hex>"` on 200/206 responses.
  Errors remain `no-store`.
- A verified name accepts either its strong tag or its current weak stat tag in `If-None-Match`; a 304 carries the tag
  that matched and the immutable Cache-Control, so revalidating an earlier weak-tagged copy upgrades its caching policy.
  Comparison is weak for both tag forms, lists, whitespace, and a lone `*`; a strong-tag match takes precedence when
  both tags match. The weak ETag uses size, nanosecond mtime, and inode; a matching `If-None-Match` takes precedence
  over Range.
- A single satisfiable `bytes=` range gets 206 with `Content-Range` and its length; an unsatisfiable range gets 416 with
  `Content-Range: bytes */<size>`. HEAD ignores Range and returns the full length (or 304); empty files ignore Range and
  return an empty 200.

### Missing asset check

`POST /api/assets/missing` awaits `assetVerification.verifyFiles`: at most four asynchronous streaming hashes at once
and 256 MiB of reads per request, with budget reservations in name order. It opens regular, non-empty files without
following symlinks and reuses verified or mismatched results only against a fresh handle stat. Unknown files larger than
the remaining budget count as missing. Each hash reads at most its reserved size; changed handle stats or pathname
identity (size, nanosecond mtime, inode, device) make the file missing. Writer and forget generations prevent an older
check from overwriting a newer verification or reporting it present. Only a digest matching the canonical name is
present; corrupt files are missing so uploads repair them. Aborting stops new hashes. The read-only check remains
available during maintenance.

### Thumbnail variant

`routes/storage.ts` admits the sizes (`widths`, `thumbnailSize`), and `http/assetThumbnails.ts` repeats them in
`ThumbnailRequest.size` and the cache entry pattern `ENTRY_NAME`. The variant (`?w=256|512`, the short side's size
class, not the output width) keeps the route's limiter, authentication before any file access, security headers, and the
open-once rule: the route opens and stats the source once and hands that handle and stat to the service, which never
reopens the source path.

- A WebP answer is `image/webp`, `inline`, served from the cache file with the same Range, HEAD, and 304 rules as the
  original.
- Its tags carry the size and transform version so they never equal the original's, another size's, or another
  version's: a verified source gets `"sha256-<hex>-w<size>-v<THUMBNAIL_VERSION>"` with the immutable Cache-Control and
  also accepts its current weak tag (a 304 then upgrades that copy); any other source gets
  `W/"<size>-<mtimeNs>-<ino>-<dev>-w<size>-v<THUMBNAIL_VERSION>"` with `private, no-cache`.
- A concrete variant-tag match answers 304 before the service runs, with no decode; a lone `*` goes through the service
  and applies to a WebP outcome only.
- The answer is `307 Temporary Redirect` to the relative, query-free `/api/asset/<hex>` with
  `x-risu-thumbnail: original`, no ETag, and the original's Cache-Control (immutable when verified, else
  `private, no-cache`) when the original should be shown: the short side is at most the size, an animated GIF or WebP
  (`pages > 1`) or a PNG with `acTL` before its first `IDAT`, a source that is not a PNG, JPEG, GIF, WebP, or AVIF or
  that sharp reports as an unsupported format, an empty source, or one over 32 MiB or 40 megapixels. Preconditions are
  ignored, so it is never a 304.
- The encoder failing to load, a full generation queue, or any other service error (I/O, memory, encoder) answers the
  same redirect with `x-risu-thumbnail: unavailable`, `busy`, or `error` and `Cache-Control: no-store` (`error` also
  logs a line); a thumbnail failure is never a 5xx. The browser and the service worker follow the redirect to the
  original, so a page needs no status handling.

## Flows

### Boot

1. `pnpm run server` starts `main.ts`; `readListenConfig` resolves the port, host, save directory, and loopback-only
   development auth bypass.
2. `createServerContext` creates the save directory and server state, then `serve()` listens with HTTPS when
   `server/ssl/certificate/server.key` and `server.crt` exist. The context attaches WebSocket handlers and starts
   snapshot, diagnostics, and job background tasks.
3. Shutdown stops admissions and timers, drains HTTP for up to eight seconds, closes remaining connections, then awaits
   `dispose()` before exiting. What it does to a restore or an import is in
   [shutdown during a restore](server-resources.md#shutdown-during-a-restore).

`__NODE__` in the flagged `index.html` lets the client mount only when this server is present. Client boot, auth, and
dev proxy setup are documented in [app-shell](app-shell.md) and [build-test-platforms](build-test-platforms.md). Opening
the store runs the [normalization pass](server-resources.md#store-open-and-normalization).

### Login flow

1. The tab stores an ES256 key pair in IndexedDB and calls `/api/test_auth`. On first setup it posts the password digest
   to `/api/set_password`, then logs in; otherwise it calls `/api/login`. The server registers the public-key hash and
   returns a short-lived JWT.
2. Later HTTP and WebSocket requests carry that JWT.
3. JWT input failures answer 400; malformed tokens and token parse/crypto exceptions use
   `{ error: "Invalid Signature" }`. The asset route still rewrites auth failures to 401. Token acceptance rules are
   shared with WebSocket authentication.

### Request bodies

Request bodies use `routes/limitedBody.ts` for both the global cap and route-specific caps. A new self-capping route is
added to `ownLimit` in `app.ts`, the condition that skips the global cap. The limiter counts and does not buffer: a
declared `Content-Length` over the cap is an immediate 413 with nothing read, and any other body reaches the route at
once as a demand-driven stream that reads its source only when the route reads. A route that answers before reading (a
failed auth check) therefore costs no body. After the route has run the limiter assigns `c.res` from what it recorded:
413 past the cap (overflow wins), otherwise 400 `{ error: "Invalid JSON body" }` (or the route's configured read error)
when the stream failed under the cap, whatever the route answered or threw meanwhile, `Cache-Control` and `RateLimit-*`
kept and the route's other headers dropped. With neither fact the route's own answer stands, an error included. A
route's read fails with `RequestBodyError`, an `HTTPException`, so `app.onError` logs nothing for it.

Three consequences follow. A route that never reads its body (the snapshot restore) refuses an over-cap one only by its
declared length; the body is discarded with the connection. A route must finish reading before it exposes a streamed
response, because an overflow found later cannot become a 413; every route under a cap does. And the source is not read
past the overflow: a client still sending gets the 413 and the connection closes 500 ms later (`@hono/node-server`'s
cleanup stalls behind the abandoned reader), except on `POST /api/assets/write`, which drains first.

The asset batch publishes each completed record by rename while the upload is still being read, so its failures are
partial by design: at the first failure the staged file is removed, the rest of the body is read and dropped, and
records renamed before it stay. An over-cap chunked batch is such a failure: its earlier records may be published when
it answers 413 (a declared length over the cap publishes nothing), and that is the same outcome as an upload that fails
midway.

### Proxying

- `/proxy` and `/proxy2` forward arbitrary upstream requests. They preserve raw request bodies, strip hop-by-hop and
  `risu-auth` headers, and keep the timeout active through response streaming; a client disconnect aborts the upstream
  call.
- `/hub-proxy/*` targets the configured Realm hub only and does not forward `risu-auth`.
- Server local-network streaming runs as a generation job over WebSocket. Its target must pass the server's
  local-network URL policy; job deletion, deadline, garbage collection, shutdown, or client disconnect aborts the
  upstream stream. See [LLM requests](llm-requests.md) for request dispatch and [plugins and MCP](plugins-mcp.md) for
  plugin providers.

## State

### Disk layout

Everything lives under `save/`. `data/`, `backups/`, and `cache/thumbnails/` are not storage namespaces.

- `server/`: the [auth and push files](#auth-and-push-files).
- `assets/`: the [user files](#user-files).
- `.tmp/`: staged writes and the per-operation export/import/restore staging folders, emptied at startup.
- `cache/thumbnails/`: the [thumbnail cache](#thumbnail-cache).
- `data/resources.sqlite` and `backups/`: [the resource store](server-resources.md#state).
- `data/generation-jobs.sqlite`: [the job receipts](server-generation.md#job-receipts).
- `data/` also holds the [request history](diagnostics.md) and the [vector cache](memory.md).

### Auth and push files

`routes/auth.ts` `createAuthStore` loads the auth files at startup (`readPasswordState`, `readKnownPublicKeys`).

- `server/password`: the client-side SHA-256 digest via `/api/crypto`. Only a missing file opens setup (`ENOENT`; other
  read errors throw). An empty or whitespace-only file logs a warning and keeps setup and password login closed until
  the operator fixes or deletes it; registered JWT keys still work, and `/api/test_auth` checks them rather than
  returning `unset`.
- `RISU_PASSWORD_SHA256` can seed a missing file durably at startup, never overwrites an existing file (even an empty
  one, with a warning that the seed was ignored), and changing the variable never rotates an existing password.
- `POST /api/set_password` is one operation on the ordered writer (key `auth:password`): the state check, the
  validation, the durable write, then the install, so of two concurrent calls one wins and the other answers
  `already set`.
- `server/known_public_key_hashes.json`: an array of strings, read into a set. A login's new key is one operation (key
  `auth:keys`): it derives the next list from the current one, writes it durably, and installs it, so two concurrent
  logins keep both keys; the login answers 200 after the write and 500 when it failed. A known key writes nothing.
- A missing key file means no known keys; malformed JSON or another shape (including an empty file) is renamed beside it
  to `known_public_key_hashes.json.corrupt-<Date.now()>`, with a warning naming that path. Startup continues with no
  known keys, so every tab logs in again with the password; other read errors throw. Deleting only `password` lets you
  set a new one but does not revoke registered clients; delete this file too for that.
- `server/web_push_vapid.json` (mode 600): the Web Push VAPID pair. Replacing it (or the `RISU_WEB_PUSH_VAPID_*`
  variables) leaves every browser subscribed with the old key: each subscribes again the next time it opens the app, or
  an open tab's page is shown again.
- `server/push_subscriptions.json` (mode 600):
  `{ version: 1, subscriptions: [{ endpoint, keys: { p256dh, auth }, expirationTime, failureCount, lastError?, updatedAt }] }`;
  `updatedAt` is the last registration refresh, at most once per 24 h for an unchanged healthy entry. Skipped
  registrations leave the stamp and list order unchanged; the 50-entry cap drops the least recently refreshed.
- The list changes only in operations on the ordered writer (key `push:subscriptions`): a registration or removal
  applies the delivery outcomes settled so far, derives the next list, writes it durably, and installs it after the
  write, and its route answers 204 after that or 500. Delivery bookkeeping (failure counts, a 404/410 removal) is one
  such operation per settled delivery batch, one write, awaited by no one; a failed bookkeeping write keeps memory and
  marks the file uncertain.

### User files

A logical key `assets/<name>` lives at `save/assets/<encodeFileName(name)>`, e.g. `assets/<sha>.png` or
`assets/inlay_<sha256>.png`. The legacy `save/database` and `save/remotes` folders are left in place and never read, and
files of the flat layout (hex file names and `__password` directly in `save/`) are neither read nor migrated. Retained
snapshots can keep assets from being deleted ([Issues](server-resources.md#issues)).

- `encodeFileName` keeps `a-z 0-9 . _ -` readable and writes every other UTF-8 byte (uppercase letters, `/`, `%`,
  spaces, non-ASCII) as `%XX`. It also escapes a trailing dot and the first character of a Windows device name
  (`con.png` → `%63on.png`). A name whose readable form exceeds 255 bytes is stored as `~<lowercase hex>`; longer than
  that is rejected.
- Only one encoding per name is canonical, and canonical names never differ by case alone, so case-insensitive
  filesystems do not merge keys.

### Thumbnail cache

`cache/thumbnails/<sha256(key)>/<entry name>` holds the asset route's derived WebP thumbnails, with each key directory
created when an entry is ready to be staged. `/api/list`, full and upstream exports (`listAssetKeys`), and snapshots
never see it, and a restore or an import leaves it in place.

- Each entry is `<sha256(key)>-w<size>-v<THUMBNAIL_VERSION>-<size>-<mtimeNs>-<ino>-<dev>` plus `.webp`, or `.orig` (an
  empty marker for a deterministic "serve the original" decision: small, animated, non-raster or unsupported, or over
  the input caps; never for a transient failure). Entries are staged under `.tmp/` and renamed into place, outside the
  maintenance gate.
- Publication and removal touch only that key's directory: after publishing, the service lists it and drops entries
  whose identity differs from the source file's current stat (all of them when the source is gone, including the one
  just written), removing the directory if empty; `/api/remove` removes the directory.
- A sweep after listen (`startBackgroundTasks`, aborted at shutdown) walks key directories and drops non-regular
  entries, entries of a missing or changed source, entries of another `THUMBNAIL_VERSION`, and entries with an unknown
  name or a hash that differs from their directory, then removes empty directories. It removes anything else at the top
  level, including a flat cache layout; entries and other top-level paths whose mtime is at or after the sweep's start
  are left alone.

### Process memory

The module-level `assetVerification` singleton holds bounded verification results and its hash queue, keyed by absolute
paths so separate save directories do not collide. The remaining state is inside the `createServerContext` closure; the
store's and the jobs' parts are in [store state](server-resources.md#process-memory) and
[job state](server-generation.md#process-memory).

- `password` and the known key hashes.
- Rate-limit counters.
- The thumbnail service (`thumbnails`): its single flights, generation slots and wait queue, per-key locks, and the
  loaded encoder. A restart loses only work in flight; the disk cache stays.

## Coupling

- Server dependencies:
  - `hono` and `@hono/node-server`.
  - `ws`, for the upgrade handler.
  - `proxy-addr` and `ipaddr.js`.
  - Node `crypto`/`fs`/`http`/`https`/`net`/`sqlite`.
  - `sharp` 0.34.5, for the asset thumbnails. Its prebuilt `@img/sharp-*` binary loads without the install script, which
    `pnpm.neverBuiltDependencies` keeps off; a host without one gets the `unavailable` redirect.
  - All of the above are prod dependencies because the Docker runtime stage installs `--prod`.
- Client dependencies that use this server: `serverAuth.ts`, `assetClient.ts`, `resourceClient.ts`, `globalApi` proxy
  code, `characterCards.hubURL` (`/hub-proxy`), `util.ts` DPoP storage.
- [Server resources](server-resources.md): its [maintenance](server-resources.md#maintenance) closes the storage writes
  too, its restores and imports use the [content-name rule](server-resources.md#backup-and-import-internals) over these
  asset files, and its uploads follow the [body rules](#request-bodies).
- [Server generation](server-generation.md): the proxy's local-network streaming is one of its jobs.

## Invariants

- Only paths resolved from the logical storage key and `STORAGE_NAMESPACES` reach user storage. Keep the hex wire
  encoding and its reversible, injective filename mapping; do not join a request value directly to a filesystem path.
- A content-addressed asset name is trusted for immutable caching only after its bytes are verified. Asset responses
  open and stat one file handle; thumbnail generation uses that same handle. Keep `/api/asset/*` authenticated and
  preserve its security headers, range, conditional-request, and thumbnail behavior.
- Accepted exposure (owner decision, 2026-10-23): a fresh immutable copy has no `Vary` on auth, so the browser's HTTP
  cache answers any same-origin request of that URL without reaching the server, including a plugin's `nativeFetch`; the
  service worker passes a request whose destination it does not sign through unsigned instead of answering 401 itself.
  Do not reopen this without a new finding.
- File publication flushes staged file data before rename and syncs its directory where supported. Preserve atomic
  replacement and the ordering of durable writes; `EINVAL` and `EPERM` from directory sync are tolerated.
- A push or auth state change is one operation on the ordered writer: read, derive, write durably, install, never a file
  task beside a state change made elsewhere. Install only after the write (delivery bookkeeping alone keeps memory on a
  failed write), and answer only after the operation ended.
- Preserve route status codes, error bodies, and wire spellings, including the `Invaild Path` response. The global JSON
  body rules are in `http/body.ts`; backup, module, CharX, Realm, and self-capping routes have their own size limits.
- Rate limits and client IPs keep Express semantics: the [four buckets](#rate-limits) stay separate; `TRUST_PROXY`
  retains Express hop-count and `proxy-addr` semantics. IPv4-mapped IPv6 addresses collapse to IPv4, and other IPv6
  addresses use a `/56` key.
- `http/staticCache.ts` injects `__NODE__` only into the client index served for the root and client routes. Static
  serving must not return an unflagged index. `attachWebSocket` owns one Node `upgrade` listener and dispatches only the
  generation and live-update socket paths.
- The server uses one local `save/` directory and one process. Docker persistence depends on the `/app/save` volume;
  removing it loses user data and registered keys.
- Keep the `100 MiB` global request-body limit and the route-specific exceptions in [Routes](#routes). Do not add
  decompression or charset-dependent JSON decoding.

## Recipes

- Add a storage operation:
  - Add a route in `routes/storage.ts` with `auth.checkAuth`, the storage limiter, `decodeKeyHeader`, and
    `resolveStorageKey`.
  - Add the matching client function in `src/ts/storage/assetClient.ts`.
- Add a storage namespace: add it to `STORAGE_NAMESPACES`; the client key prefix is the folder name. The folders in
  [Disk layout](#disk-layout) are taken.
- Change auth:
  - Client: `src/ts/storage/serverAuth.ts` (`createAuth`, `checkAuth`, `digestPassword`).
  - Server: `routes/auth.ts` (`verifyJwt`, the `/api/login` route).
  - Verify first run, restart, token expiry, and unknown keys.
- Change proxy policy: server `sanitizeTargetUrl`, client `localNetwork.ts` + `fetchNative`.
- Change packaging: `Dockerfile`, the README Docker steps, and `package.json` `server` together. Any new root folder the
  server imports at runtime (like `shared/`) needs a `COPY` in the `runtime` stage.

## Tests

Server tests live in `server/src/tests/` and select Vitest's Node environment. Runner, slow-test, and timing rules
belong to [test-harness](test-harness.md); `slow` and `e2e` memberships are in its [Tests](test-harness.md#tests).

- `testSupport.ts` `createTestServer` is the in-process server of the route and lifecycle tests in all three server
  guides: a temporary root with a minimal `dist/index.html`, or a reused one for a restart, with injected kinds, clocks,
  limits, and services. `testRestoreRunner` stages a restore in process, so a gate test starts no worker.
- `createServerContext`'s test seams include `generationRunner`, `scriptWorkerOptions`, `routeLimits`, `cbsTimeLimits`,
  `realmStagingTimer`, `memoryTaskOptions`, `thumbnailOptions`, and `restore`.
- `assetVerification.test.ts` uses injected hashers and latches to hold file reads while fake timers control the queue.
- Boot, auth, limits, shutdown:
  `pnpm --silent test:agent server/src/tests/{app,listenConfig,shutdown,shutdownAdmission}.test.ts`.
- Storage and HTTP:
  `pnpm --silent test:agent server/src/tests/{assets,assetRoute,assetVerification,assetThumbnails,proxy}.test.ts`.
- Ordered and durable writes: `pnpm --silent test:agent server/src/tests/{orderedWriter,durableWrite}.test.ts`.
- Diagnostics and request history coverage belongs to [diagnostics](diagnostics.md); client transport tests to
  [global API](global-api.md).

## Known Hazards

### Issues

- `/api/remove` deletes sequentially: a filesystem error stops the batch with 500 and leaves earlier deletions in place.
- `/api/asset/*` verification is in memory and stat-based; it starts empty after restart and cannot detect an outside
  same-size edit that restores the full stat.
- The thumbnail cache has no byte cap.
- JWT validation does not check issuer, audience, `typ`, or `iat`, and a token without `exp` does not expire.
- `/hub-proxy` is unauthenticated and forwards request headers other than `risu-auth` to the configured hub.

### Limitations

- Directory fsync may be unsupported on a mount (`EINVAL`/`EPERM`); in that case a successful rename or link is not
  guaranteed to survive power loss, for the auth password and known-key files and the push subscriptions too. Decision:
  Server Byte Budgets D7, archive.
- A stalled disk holds a login, a subscription write, a share (its event barrier), and a dispose that waits for them,
  since each owes a durable answer; only the journal's own drain has a deadline (`finish`, 1 s), and its synchronous
  takeover can still block. Neither the queue nor a request is cancelled, because a hung volume already stalls the
  store's synchronous commits and Docker's stop timeout is the bound. A process that ends mid-write leaves a temporary
  file beside its target.
- Replacing bytes under an already cached immutable content name does not update a browser's cached asset, and a fresh
  copy stays under the [accepted exposure](#invariants). Decision: Direct Asset URLs closeout, archive.
- `/api/set_password` and `/api/crypto` are unauthenticated by design and rate limited. A server has one password and
  registered browser keys, not separate users. Decision: Static Audit Fixes Q6 and Server-Owned Data non-goals, archive.
- A chunked body over the cap to the snapshot restore is not refused: the operation runs and the adapter discards the
  body ([Request bodies](#request-bodies)). The snapshot restore is authenticated. Decision: Server Byte Budgets D1,
  archive.

### Gotchas

- Staging under `save/.tmp/` must share a filesystem with asset targets for atomic rename.
- Storage namespace folders are trusted: a symlinked `save/assets` directory is followed, although individual file opens
  reject symlinks where the OS supports it.
- `/api/asset/*` serves one byte range. Thumbnail transforms are versioned by `THUMBNAIL_VERSION`; bump it when
  transform output or input policy changes. Animation detection covers multi-page formats reported by `sharp` plus PNG
  `acTL`.
- Static serving precedes the asset route. A file emitted under `dist/api/asset/` would be served before asset
  authentication and headers; the current build emits no `api/` directory.
- `/proxy` and `/proxy2` can reach arbitrary targets; the local-network restriction applies to server streaming jobs.
- Reverse proxies must preserve encoded path segments: decoding `%2F` can split a resource id containing a slash.
  Deployment behavior remains unverified.
