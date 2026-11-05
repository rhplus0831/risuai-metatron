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
  - `src/ts/storage/serverAuth.ts` → `persistence.md`; `src/ts/storage/assetClient.ts` → `assets.md`.
  - `globalApi.svelte.ts` `fetchNative` → `network-jobs.md`.
  - `characterCards.ts` `hubURL` → `characters-modules.md`.

## Files

The server is TypeScript run directly by Node's type stripping: `pnpm run server` runs `node server/src/main.ts` on Node
`>=24`; there is no server build step. `server/tsconfig.json` strictly checks the server and its imports from `shared/`.
A module's contract is its doc comments; an entry names its path, role, and identifiers.

### Entrypoints and configuration

- `server/src/main.ts` the process entry (HTTP or HTTPS, upgrades, shutdown): `startServer`, `REQUEST_TIMEOUT_MS`,
  `SHUTDOWN_GRACE_MS`, `TRUST_PROXY`.
- `server/src/listenConfig.ts` bind, storage, and development-auth settings: `readListenConfig`, `ListenConfig` (`PORT`,
  `RISU_HOST`, `RISU_SAVE_DIR`, `RISU_AGENT_DEV_AUTH_BYPASS`), `isLoopbackHost`, `parsePasswordSeed`,
  `parseAssetClockOffset`.
- `server/src/app.ts` the assembly of state, routes, and lifecycle: `createServerContext`, `RouteLimits`,
  `attachWebSocket`, `startBackgroundTasks`, `beginShutdown`, `dispose`. It and its route factories consume the
  variables below; a value one of them cannot parse stops the start, with the variable's name.
- `RISU_PASSWORD_SHA256`; `RISU_MAX_IMPORT_BYTES` ([backup routes](server-resources.md#backup-routes));
  `RISU_MAX_UPSTREAM_DB_BYTES` ([upstream backups](server-resources.md#upstream-backups));
  `RISU_UPSTREAM_IMPORT_HEAP_MB`, `RISU_UPSTREAM_EXPORT_HEAP_MB`, and `RISU_RESTORE_HEAP_MB`
  ([heap limits](server-resources.md#limitations)); `RISU_SQLITE_SYNCHRONOUS`
  ([store connection](server-resources.md#store-connection)); and `RISU_REQUEST_HISTORY_MAX_BYTES`,
  `RISU_DIAGNOSTICS_DIR`, and `RISU_DIAGNOSTICS_MAX_BYTES` ([diagnostics](diagnostics.md)).

### Services and helpers

- `server/src/push/pushService.ts` Web Push for completions: `createPushService`, `completionTopic`, `PushService`,
  `MAX_PUSH_SUBSCRIPTIONS`; its outcomes are content-free `push` events ([diagnostics](diagnostics.md)).
- `server/src/data/orderedWriter.ts` the auxiliary-write scheduler: `createOrderedWriter`, one per context, shared by
  the auth store, the diagnostics journal, and the push service.
- `server/src/data/durableWrite.ts` flushed temporary file renamed into place, for the auth files and the push
  subscriptions: `writeFileDurable`, `writeFileDurableSync`, `mkdirDurable`, `mkdirDurableSync`, `syncDir`.
- `server/src/http/body.ts` JSON bodies: `readJsonBody`. `server/src/http/rateLimit.ts` the buckets:
  `createRateLimiter`, `rateLimitKey`. `server/src/http/clientIp.ts` client IPs: `parseTrustProxyEnv`, `compileTrust`,
  `getClientIp`.
- `server/src/http/compressedJson.ts` compression of the [resource reads](server-resources.md#resource-routes):
  `compressedJson`. `server/src/http/staticCache.ts` the client and `dist/` caching: `createStaticCache`,
  `serveCachedIndex`, `STATIC_COMPRESSIBLE_EXTENSIONS`.
- `server/src/http/assetVerification.ts` content-name verification: `assetVerification`, `contentNameHash`,
  `verifyFiles`, `holdsVerifiedAsset`. `server/src/http/assetThumbnails.ts` the thumbnail service and cache:
  `createThumbnailService`, `THUMBNAIL_VERSION`, `ThumbnailRequest`, `ENTRY_NAME`.
- `server/src/data/assetLifecycle.ts` the [asset mark](#asset-mark) and sweep: `recognize`, `sweep`;
  `server/src/http/diskSpace.ts` `freeBytes`.
- `diagnostics/` owns request history, diagnostic journals, reports, and support shares ([diagnostics](diagnostics.md)).
- Packaging: `server/ssl/` generates local certificates; `Dockerfile`, `.dockerignore`, `server.sh`, and `server.bat`
  define deployment and launch behavior.

### Routes

`server/src/app.ts` `createServerContext` is the registration map of the server's HTTP and WebSocket surface: check it
and the named route module before changing a path or its admission policy. In registration order:

1. `app.onError`, then shutdown admission before body parsing (what it tracks, refuses, and marks `no-store`: its
   comments).
2. `limitedBody`, the 100 MiB global cap, which the `ownLimit` routes skip ([Request bodies](#request-bodies)).
3. `GET /`, `GET /index.html`, and every `isClientRoutePath` path (`shared/routes.ts`, [URL routes](app-shell.md)):
   `serveCachedIndex`, with no auth and no limiter.
4. `createStaticCache`, then `serveStatic`, for every other GET/HEAD of `dist/*`, with no auth and no limiter. HTML (the
   injected index included) and requests carrying `Range` or `If-Range` are never negotiated: they get identity.
5. The route families, each documented in one place:
   - This guide: [proxy](#proxy-routes), [push](#push-routes),
     [request history and diagnostics](#request-history-and-diagnostics-routes), [auth](#auth-routes), and
     [storage](#storage-routes).
   - [Server resources](server-resources.md#files): `/api/resources*`, `/api/llm-secrets/*`, `/api/chats/search`,
     `/api/chat-checkpoints*`, `/api/backups*`, and `/api/import/*`.
   - [Server generation](server-generation.md#files): `/api/generations*`, `/api/transform*`, `/api/translate/message`,
     `/api/memory/tasks*`, `/api/llm/*`, and `/api/tokens/*`.
   - [Live-update feed](live-update-feed.md#files): `/api/events/ws`.
   - [Structured memory](structured-memory/records.md#the-read-routes): `/api/memory/structured/*`.

### Rate limits

`app.ts` builds four buckets, each keyed by client IP. A WebSocket upgrade has no HTTP limiter.

- The authenticated limiter, 2000/min: the proxy, resource, and job routes and every other route not named below.
- The storage limiter, 2000/min, with its own bucket so an asset burst (a module import or export) cannot starve
  resource sync: the [storage routes](#storage-routes).
- The auth limiter, 2000/min: `/api/test_auth` and `/api/crypto` share it.
- The login limiter, 10 per 30 s: `/api/login` and `/api/set_password` share it.

### Proxy routes

`server/src/routes/proxy.ts` `registerProxyRoutes`, all on the authenticated limiter.

- `GET`/`POST /proxy`, `/proxy2`: `checkProxyAuth` (the stored password in `risu-auth`, or a registered ES256 JWT); with
  `risu-aux-op`, JWT only (`server/src/llm/auxOps.ts`, [LLM requests](llm-requests.md)).
- `GET /hub-proxy/*`: no auth; `https://sv.risuai.xyz` only.

### Push routes

`server/src/routes/push.ts` `registerPushRoutes`: JWT, authenticated limiter, no epoch; the statuses are in its comment,
the refresh interval is `PUSH_REGISTRATION_REFRESH_MS` (`shared/notifications.ts`).

- `GET /api/push/key`; `PUT` and `DELETE /api/push/subscription`, with 16 KiB bodies read after authentication.

### Request history and diagnostics routes

`/api/request-history*` and `/api/diagnostics*` (`registerRequestHistoryRoutes`, `registerDiagnosticsRoutes`): JWT,
authenticated limiter, `no-store`, bodies capped after authentication (`PUT /api/request-history/share` 4 KiB,
`POST /api/diagnostics/report` 1 MiB). The [routes and their contract](diagnostics.md#files) belong to diagnostics.

### Auth routes

`server/src/routes/auth.ts` `createAuthStore` (`registerRoutes`, `verifyJwt`, `checkAuth`); the bodies are capped at
`MAX_AUTH_BODY_BYTES` and read before any authentication.

- `GET /api/test_auth`: no auth, auth limiter. `POST /api/login`: password digest, login limiter.
- `POST /api/crypto`: **no auth**, auth limiter. `POST /api/set_password`: **no auth**, only while unset; login limiter.

### Storage routes

`server/src/routes/storage.ts` `registerStorageRoutes`: `checkAuth` (JWT), storage limiter, hex UTF-8 logical keys
(`decodeKeyHeader`, `resolveStorageKey`); each route's contract is the comment above it.

- `GET /api/read`, `GET /api/list`, `POST /api/write`, and `GET /api/remove` (no client calls it).
- `GET`/`HEAD /api/asset/*`: `assetHeaders`, `serveAssetFile`, `shared/assetMime.ts` (`assetMimeType`,
  `isActiveAssetExtension`), `assetVerification`; `?w=256|512` is the thumbnail variant (`createThumbnailService`). The
  cache headers, ETags, and the variant's `307` reasons (`x-risu-thumbnail`) are the comment above the route.
- `POST /api/assets/{write,read}` (`shared/assetBatch.ts` framing); `POST /api/assets/missing` (`ASSET_MISSING_PATH`).
- `GET /api/assets/{report,status}`, `POST /api/assets/{scan,sweep}`: `server/src/routes/assetLifecycle.ts`,
  `shared/assetLifecycle.ts`.
- The thumbnail sizes are admitted here (`widths`, `thumbnailSize`) and repeated in `ThumbnailRequest.size` and
  `ENTRY_NAME`: change them together. The browser and the service worker follow the variant's redirect to the original,
  so a page needs no status handling.

## Flows

### Boot

1. `server/src/main.ts` `startServer`: `readListenConfig`, `createServerContext` (save directory by `mkdirDurableSync`,
   state, routes), `serve()`, `attachWebSocket`, `startBackgroundTasks` (`generationJobs.startGc`, `snapshots.start`,
   `diagnostics.start`, the thumbnail sweep, the [asset mark](#asset-mark)).
2. SIGINT or SIGTERM: `beginShutdown`, the HTTP drain (`SHUTDOWN_GRACE_MS`), `dispose()`; for a restore or an import see
   [shutdown during a restore](server-resources.md#shutdown-during-a-restore).

`__NODE__` in the flagged `index.html` lets the client mount only when this server is present. Client boot, auth, and
dev proxy setup are documented in [app-shell](app-shell.md) and [build-test-platforms](build-test-platforms.md). Opening
the store runs the [normalization pass](server-resources.md#store-open-and-normalization).

### Asset mark

`createAssetLifecycle` (an hour after `startBackgroundTasks`, then daily, or `POST /api/assets/scan`;
`RISU_ASSET_GRACE_DAYS`, `RISU_AGENT_DEV_ASSET_CLOCK_OFFSET_MS`) marks the roots its header lists
(`snapshots.stageCopy`, `createExportHolds`) into `data/asset-lifecycle.sqlite`. The sweep (`POST /api/assets/sweep`)
deletes past-grace candidates; its batches and synchronous turn are `sweep`'s comment.

### Login flow

1. The tab keeps an ES256 key pair in IndexedDB and asks `/api/test_auth`. On first setup it posts the password digest
   to `/api/set_password`, then logs in; with an unknown key it calls `/api/login`, which registers the public-key hash
   and answers `{ status: "success" }`, with no token.
2. Every HTTP and WebSocket request carries a JWT the tab signs itself (`createAuth`, `src/ts/storage/serverAuth.ts`,
   five minutes). A failed check answers 400 (`failureBodies`), 401 on the asset route; sockets share the rule
   (`isAuthorizedToken`).

### Request bodies

`server/src/routes/limitedBody.ts` `limitedBody` (`replaceAnswer`, `RequestBodyError`) applies the global cap
(`MAX_BODY_BYTES`, 100 MiB; `RouteLimits.bodyBytes` in tests) and the route caps. A new self-capping route wraps itself
in its own `limitedBody(<cap>)`, as `server/src/routes/auth.ts` and `server/src/routes/push.ts` do, and is added to
`ownLimit` in `server/src/app.ts` (and the cap list in the comment above it), which skips the global cap. Cap owners:
[resources](server-resources.md#files), [generation](server-generation.md#files), [storage](#storage-routes),
[auth](#auth-routes), [push](#push-routes), and [diagnostics](#request-history-and-diagnostics-routes).

- A route that never reads its body (the snapshot restore) refuses an over-cap one only by its declared length.
- A route must finish reading before it exposes a streamed response, as every capped route does: a later overflow cannot
  become a 413.
- The source is not read past the overflow: a client still sending gets the 413 and the connection closes 500 ms later
  (`@hono/node-server`'s cleanup stalls behind the abandoned reader), except on `POST /api/assets/write`, which drains
  first. That batch publishes each record as it completes, so an over-cap chunked one keeps the records renamed before
  the overflow, as any batch failing midway does.

### Proxying

- `/proxy` and `/proxy2` relay a tab's request (`fetchNative`, [network and jobs](network-jobs.md)) to any target,
  `/hub-proxy/*` only to the Realm hub, never with `risu-auth`; header, body, timeout, and abort rules are the comments
  in `server/src/routes/proxy.ts`.
- Server local-network streaming bypasses them: with `localNetworkMode` on and a local URL,
  `getLocalNetworkRequestOptions` (`server/src/llm/openAI/shared.ts`) selects the `local_network` route and its timeout,
  and rejects nothing. The stream runs inside a generation job and ends with it; the job's abort and owner-absence rules
  belong to [server generation](server-generation.md#generation-channels). See [LLM requests](llm-requests.md) for
  request dispatch and [plugins](plugin-sandbox.md) for plugin providers.

## State

### Disk layout

Everything lives under `save/`. `data/`, `backups/`, and `cache/thumbnails/` are not storage namespaces.

- `server/`: the [auth and push files](#auth-and-push-files).
- `assets/`: the [user files](#user-files).
- `.tmp/`: staged writes and the per-operation export/import/restore staging folders, emptied at startup.
- `cache/thumbnails/`: the [thumbnail cache](#thumbnail-cache).
- `data/resources.sqlite` and `backups/`: [the resource store](server-resources.md#state).
- `data/generation-jobs.sqlite`: [the job receipts](server-generation.md#job-receipts).
- `data/` also holds the [request history](diagnostics.md), the [vector cache](memory.md), and the
  [asset ledger](#asset-mark).

### Auth and push files

`routes/auth.ts` `createAuthStore` loads the auth files at startup (`readPasswordState`, `readKnownPublicKeys`).

- `save/server/password`: the client-side SHA-256 digest via `/api/crypto`. Only a missing file opens setup (`ENOENT`;
  other read errors throw). An empty or whitespace-only file logs a warning and keeps setup and password login closed
  until the operator fixes or deletes it; registered JWT keys still work, and `/api/test_auth` checks them rather than
  returning `unset`.
- `RISU_PASSWORD_SHA256` can seed a missing file durably at startup, never overwrites an existing file (even an empty
  one, with a warning that the seed was ignored), and changing the variable never rotates an existing password.
- `POST /api/set_password` is one operation on the ordered writer (key `auth:password`): the state check, the
  validation, the durable write, then the install, so of two concurrent calls one wins and the other answers
  `already set`.
- `save/server/known_public_key_hashes.json`: an array of strings, read into a set. A login's new key is one operation
  (key `auth:keys`): it derives the next list from the current one, writes it durably, and installs it, so two
  concurrent logins keep both keys; the login answers 200 after the write and 500 when it failed. A known key writes
  nothing.
- A missing key file means no known keys; malformed JSON or another shape (including an empty file) is renamed beside it
  to `known_public_key_hashes.json.corrupt-<Date.now()>`, with a warning naming that path. Startup continues with no
  known keys, so every tab logs in again with the password; other read errors throw. Deleting only `password` lets you
  set a new one but does not revoke registered clients; delete this file too for that.
- `save/server/web_push_vapid.json` (mode 600): the Web Push VAPID pair. Replacing it (or the `RISU_WEB_PUSH_VAPID_*`
  variables) leaves every browser subscribed with the old key: each subscribes again the next time it opens the app, or
  an open tab's page is shown again.
- `save/server/push_subscriptions.json` (mode 600):
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
files of the flat layout (hex file names and `__password` directly in `save/`) are neither read nor migrated. Only the
[sweep](#asset-mark) deletes an asset.

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

- Each entry is `<sha256(key)>-w<size>-v<THUMBNAIL_VERSION>-<size>-<mtimeNs>-<ino>-<dev>` plus `.webp`, or `.orig`, an
  empty marker for a deterministic "serve the original" decision (`createThumbnailService`'s comment has when). Entries
  are staged under `.tmp/` and renamed into place, outside the maintenance gate.
- Publication and removal touch only that key's directory: after publishing, the service lists it and drops entries
  whose identity differs from the source file's current stat (all of them when the source is gone, including the one
  just written), removing the directory if empty; `/api/remove` removes the directory.
- A sweep after listen (`startBackgroundTasks`, aborted at shutdown) walks key directories and drops non-regular
  entries, entries of a missing or changed source, entries of another `THUMBNAIL_VERSION`, and entries with an unknown
  name or a hash that differs from their directory, then removes empty directories. It removes anything else at the top
  level, including a flat cache layout; entries and other top-level paths whose mtime is at or after the sweep's start
  are left alone.

### Process memory

The module-level `assetVerification` and `assetLeases.ts` (key locks, leases) singletons are keyed by absolute paths so
separate save directories do not collide. The remaining state is inside the `createServerContext` closure; the store's
and the jobs' parts are in [store state](server-resources.md#process-memory) and
[job state](server-generation.md#process-memory).

- `password` and the known key hashes.
- Rate-limit counters.
- The thumbnail service (`thumbnails`): its single flights, generation slots and wait queue, per-key locks, and the
  loaded encoder. A restart loses only work in flight; the disk cache stays.
- The asset mark's last report, run identity, and export holds.

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
- Every server publish or reuse of an asset key goes through `claimAssetKey`; a handout of an existing inlay id first
  takes `claimInlayId`.
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
- Change proxy policy: server `server/src/routes/proxy.ts` `registerProxyRoutes`, client
  `src/ts/network/localNetwork.ts` + `fetchNative`.
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
  [network and jobs](network-jobs.md).

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
- Swept bytes stay in a browser's immutable cache until evicted; browser-only keys are no root. Decision: Asset
  Lifecycle D11, archive.
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
- `/proxy` and `/proxy2` can reach arbitrary targets: no address or local-network restriction applies to them.
- Reverse proxies must preserve encoded path segments: decoding `%2F` can split a resource id containing a slash.
  Deployment behavior remains unverified.
