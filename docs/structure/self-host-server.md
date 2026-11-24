# Self-Host Server (Hono on Node), Docker

## Scope

The Hono/Node process, HTTP middleware, static client, authentication, asset storage and cleanup, thumbnails, proxy, Web
Push, remote-command relay, TLS, Docker and launch scripts.

- For record, backup and file-import routes, use [server resources](server-resources.md). For generation jobs, their
  socket and completion holds, use [server generation](server-generation.md). The provider routes belong to
  [LLM requests](llm-requests.md#server-request-layer), and history, diagnostic reports and shares to
  [diagnostics](diagnostics.md).
- The [live-update feed](live-update-feed.md#presence) owns socket presence and addressed notices.
  [Network jobs](network-jobs.md#remote-send) owns the sending and host tabs. For the browser side of asset transport,
  use [assets](assets.md).

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
  `attachWebSocket`, `startBackgroundTasks`, `beginShutdown`, `dispose`.
- `RISU_AI_DISCLOSURE`: `1` or `true` (trimmed, any case) turns the client's AI disclosure on (the empty-chat warning,
  the request-info disclaimer, and the model button on rows with generation model metadata); unset or any other value
  leaves it off. `createServerContext` reads it once, so a change needs a restart and a page reload.
- `RISU_PASSWORD_SHA256`; `RISU_MAX_IMPORT_BYTES` ([backup routes](server-resources.md#backup-routes));
  `RISU_MAX_UPSTREAM_DB_BYTES` ([upstream backups](server-resources.md#upstream-backups));
  `RISU_UPSTREAM_IMPORT_HEAP_MB`, `RISU_UPSTREAM_EXPORT_HEAP_MB`, and `RISU_RESTORE_HEAP_MB`
  ([heap limits](server-resources.md#limitations)); `RISU_SQLITE_SYNCHRONOUS`
  ([store connection](server-resources.md#store-connection)); and `RISU_REQUEST_HISTORY_MAX_BYTES`,
  `RISU_DIAGNOSTICS_DIR`, and `RISU_DIAGNOSTICS_MAX_BYTES` ([diagnostics](diagnostics.md)).

### Services and helpers

- `server/src/push/pushService.ts` Web Push for completions: `createPushService`, `completionTopic`, `PushService`,
  `MAX_PUSH_SUBSCRIPTIONS`. `server/src/push/completionHolds.ts` `createCompletionHolds`, `CompletionHolds`,
  `MAX_COMPLETION_HOLDS`: completion pushes a job asked to hold, in process memory
  ([completion holds](server-generation.md#completion-holds)).
- `server/src/remoteCommands.ts` `createRemoteCommands`: the process-local command registry, deadlines and retry
  identity. `shared/remoteCommands.ts` owns the HTTP contract, states, refusal codes, action identity and caps.
- `server/src/data/orderedWriter.ts` the auxiliary-write scheduler: `createOrderedWriter`, `OrderedWriter`.
- `server/src/data/durableWrite.ts` durable file publication and directory creation: `writeFileDurable`,
  `writeFileDurableSync`, `mkdirDurable`, `mkdirDurableSync`, `syncDir`.
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

`server/src/app.ts` `createServerContext` registers HTTP and WebSocket services; its module header owns middleware
ordering, shutdown admission, and body-cap exceptions (`app.onError`, `limitedBody`, `ownLimit`;
[Request bodies](#request-bodies)). Check it and the named route module before changing a path or its admission policy.
Route lookup order:

1. `GET /`, `GET /index.html`, and `isClientRoutePath` paths (`shared/routes.ts`, [URL routes](app-shell.md)):
   `server/src/http/staticCache.ts` `serveCachedIndex`.
2. Other `dist/*` GET/HEAD: `server/src/http/staticCache.ts` `createStaticCache`, then `serveStatic` in `app.ts`.
3. Route families and their owners:
   - This guide: [proxy](#proxy-routes), [push](#push-routes), [remote commands](#remote-command-routes),
     [request history and diagnostics](#request-history-and-diagnostics-routes), [auth](#auth-routes), and
     [storage](#storage-routes).
   - [Server resources](server-resources.md#files), [server generation](server-generation.md#files),
     [live-update feed](live-update-feed.md#files), and [structured memory](structured-memory/README.md).

### Remote-command routes

`server/src/routes/remoteCommands.ts` mounts the relay at `REMOTE_COMMANDS_PATH`. `registerRemoteCommandRoutes` owns
authentication, the body and epoch checks, and participant visibility. `server/src/remoteCommands.ts`
`createRemoteCommands` owns admission, retry, attempt numbers, transitions and expiry. The wire types, action identity,
host compatibility and size limits live in `shared/remoteCommands.ts` (`remoteCommandAction`,
`remoteCommandNeedsActionSupport`).

- The sender posts a send or reload, polls `/:id/status` and can post `/:id/cancel`. The target host receives an
  [addressed notice](live-update-feed.md#presence), reads `/:id` with its contract version, and posts `/:id/state` with
  the attempt it read. Only a compatible read delivers the body. Version 2 preserves Continue, reroll and speaker fields
  so an older host cannot accidentally execute an ordinary send.
- The relay checks the original sender and action before retargeting or replay. Retrying an open command preserves the
  first body and clears its stop request. A sender's cancel can close a queued command or request a stop from its host.
  The host owns execution and cancellation. An absent command cannot establish whether a generation ran. See the
  [tab recovery rules](network-jobs.md#remote-send).

### Rate limits

`app.ts` builds four buckets, each keyed by client IP. A WebSocket upgrade has no HTTP limiter.

- The authenticated limiter, 2000/min: proxy, resource, job, push, request-history, diagnostics, and the other API
  services outside the storage/auth/login buckets. The client index and `dist/` static handlers have no limiter.
- The storage limiter, 2000/min, with its own bucket so an asset burst (a module import or export) cannot starve
  resource sync: the [storage routes](#storage-routes).
- The auth limiter, 2000/min: `/api/test_auth` and `/api/crypto` share it.
- The login limiter, 10 per 30 s: `/api/login` and `/api/set_password` share it.

### Proxy routes

`server/src/routes/proxy.ts` `registerProxyRoutes`; its module header owns authentication, limiter, and target policy.

- `GET`/`POST /proxy`, `/proxy2`: `checkAuth`, a registered JWT only; the stored password digest in `risu-auth` gets the
  usual JWT failure. Auxiliary operations: `server/src/llm/auxOps.ts` ([LLM requests](llm-requests.md)).
- `GET /hub-proxy/*`: configured hub (default `https://sv.risuai.xyz`), unauthenticated. `hubHeaders` puts
  `UNTRUSTED_CONTENT_CSP` (`server/src/http/securityHeaders.ts`, shared with `assetHeaders`) and `nosniff` on every
  answer, the limiter's 429 and the route's 502 included, so a hub document gets an opaque origin and runs no script.
  Hub responses strip `Set-Cookie` and `Clear-Site-Data` on success, errors, and redirects.

### Push routes

`server/src/routes/push.ts` `registerPushRoutes`; its module header and export doc own admission, body caps, and
statuses. The refresh interval is `PUSH_REGISTRATION_REFRESH_MS` (`shared/notifications.ts`).

- `GET /api/push/key`; `PUT` and `DELETE /api/push/subscription`.
- Every answer is `no-store`, the limiter's 429, the JWT failure's 400 and the body cap's 413 included: the routes'
  first middleware sets it.

### Request history and diagnostics routes

`/api/request-history*` and `/api/diagnostics*` (`registerRequestHistoryRoutes`, `registerDiagnosticsRoutes`), including
`PUT /api/request-history/share` and `POST /api/diagnostics/report`: admission and cap wiring in the `server/src/app.ts`
module header; [route contracts](diagnostics.md#files) belong to diagnostics.

### Auth routes

`server/src/routes/auth.ts` `createAuthStore` (`registerRoutes`, `verifyJwt`, `checkAuth`, `MAX_AUTH_BODY_BYTES`); its
module header owns authentication, limiter selection, and body caps.

- `GET /api/test_auth`; `POST /api/login`.
- `POST /api/crypto`; `POST /api/set_password`.

### Storage routes

`server/src/routes/storage.ts` `registerStorageRoutes` (`decodeKeyHeader`, `resolveStorageKey`); its module header owns
admission, wire keys, body caps, and response policy.

- `GET /api/{read,list}`, `POST /api/write`, and `GET /api/remove` (no client calls it).
- `GET`/`HEAD /api/asset/*`: `assetHeaders`, `serveAssetFile`, `shared/assetMime.ts` (`assetMimeType`,
  `isActiveAssetExtension`), `assetVerification`; `?w=256|512` is the thumbnail variant (`createThumbnailService`). Its
  module header and route comment own validators, caching, and redirects (`x-risu-thumbnail`).
- `POST /api/assets/{write,read,missing}` (`shared/assetBatch.ts` framing; `ASSET_MISSING_PATH`).
- `GET /api/assets/{report,status,preview/*}`, `POST /api/assets/{scan,sweep}`: `server/src/routes/assetLifecycle.ts`,
  `registerAssetLifecycleRoutes`, `shared/assetLifecycle.ts`.
- The thumbnail sizes are admitted here (`widths`, `thumbnailSize`) and repeated in `ThumbnailRequest.size` and
  `ENTRY_NAME`: change them together. Browsers and the service worker follow the variant's redirect; pages need no
  status handling.

## Flows

### Boot

1. `server/src/main.ts` `startServer`: `readListenConfig`, `createServerContext` (save directory by `mkdirDurableSync`,
   state, routes), `serve()`, `attachWebSocket`, `startBackgroundTasks` (`generationJobs.startGc`, `snapshots.start`,
   `diagnostics.start`, the thumbnail sweep, the [asset mark](#asset-mark)).
2. SIGINT or SIGTERM: `beginShutdown`, the HTTP drain (`SHUTDOWN_GRACE_MS`), `dispose()`; for a restore or an import see
   [shutdown during a restore](server-resources.md#shutdown-during-a-restore).

`__NODE__` in the flagged `index.html` lets the client mount only when this server is present; the same script carries
`__RISU_AI_DISCLOSURE__` (`RISU_AI_DISCLOSURE`), which the client's `aiLawApplies` reads. The flag is part of the
index's ETag and the index is revalidated by ETag only (no `Last-Modified`, `If-Modified-Since` ignored), so a browser
holding the page gets the new flag after a restart. Client boot, auth, and dev proxy setup are documented in
[app-shell](app-shell.md) and [build-test-platforms](build-test-platforms.md). Opening the store runs the
[normalization pass](server-resources.md#store-open-and-normalization).

### Asset mark

`createAssetLifecycle` (an hour after `startBackgroundTasks`, then daily, or `POST /api/assets/scan`;
`RISU_ASSET_GRACE_DAYS`, `RISU_AGENT_DEV_ASSET_CLOCK_OFFSET_MS`) marks the roots its header lists
(`snapshots.stageCopy`, `createExportHolds`) into `data/asset-lifecycle.sqlite`. The sweep (`POST /api/assets/sweep`)
deletes past-grace candidates; its batches and synchronous turn are `sweep`'s comment.

### Login flow

1. The tab keeps an ES256 key pair in IndexedDB and asks `/api/test_auth`. On first setup it posts the password digest
   to `/api/set_password`, then logs in; with an unknown key it calls `/api/login`, which registers the public-key hash
   and answers `{ status: "success" }`, with no token.
2. Subsequent authenticated HTTP requests and socket upgrades carry a JWT the tab signs itself (`createAuth`,
   `src/ts/storage/serverAuth.ts`, five minutes). `verifyJwt` needs a finite `exp`, not past and at most 24 hours ahead
   of the server clock (`MAX_JWT_FUTURE_SECONDS`). A failed check answers 400 (`failureBodies`), 401 on the asset route;
   sockets share the rule (`isAuthorizedToken`). The password digest is checked only by `/api/login`, never accepted as
   `risu-auth`.

### Request bodies

`server/src/routes/limitedBody.ts` `limitedBody` and `RequestBodyError` enforce the streaming body limit. A new
self-capping route must install its cap at the required point relative to authentication and join `ownLimit` in
`server/src/app.ts` to bypass the global 100 MiB cap. The app header lists exceptions and the route module specifies its
limit.

- Finish reading a capped request before returning a response stream. A handler that skips the body entirely can only
  reject its declared length.
- A partial asset batch keeps completed records. Its route drains the rest of the request before answering an overflow
  ([storage routes](#storage-routes)).

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

Runtime data defaults to `save/`; `RISU_DIAGNOSTICS_DIR` can place diagnostics elsewhere. `data/`, `backups/`, and
`cache/thumbnails/` are not storage namespaces.

- `server/`: the [auth and push files](#auth-and-push-files).
- `assets/`: the [user files](#user-files).
- `.tmp/`: staged writes and the per-operation export/import/restore staging folders, emptied at startup.
- `cache/thumbnails/`: the [thumbnail cache](#thumbnail-cache).
- `data/resources.sqlite` and `backups/`: [the resource store](server-resources.md#state).
- `data/generation-jobs.sqlite`: [the job receipts](server-generation.md#job-receipts).
- `data/` also holds the [request history](diagnostics.md), the [vector cache](memory.md), and the
  [asset ledger](#asset-mark).

### Auth and push files

- `save/server/password` holds the SHA-256 password digest. `RISU_PASSWORD_SHA256` can seed a missing file. Only absence
  opens setup. A damaged empty file disables password login and setup until repaired. Registered keys still work. See
  `server/src/routes/auth.ts` `readPasswordState` and `createAuthStore` for startup and serialized writes.
- `save/server/known_public_key_hashes.json` holds registered browser keys independently of the password. To revoke
  those keys during a password reset, remove the key file too. `readKnownPublicKeys` quarantines malformed contents and
  starts with no registered keys.
- `save/server/web_push_vapid.json` and `save/server/push_subscriptions.json` persist the VAPID identity and browser
  subscriptions outside resource backups. Changing the key pair requires browsers to subscribe again.
  `server/src/push/pushService.ts` `createPushService` owns environment overrides, file modes, subscription refresh,
  eviction, and delivery bookkeeping. See [push delivery](network-jobs.md#push-delivery) for re-registration.

### User files

`server/src/routes/storage.ts` `STORAGE_NAMESPACES`, `encodeFileName` and `decodeFileName` map logical keys under
`assets/` to one reversible, case-safe path component in `save/assets/`. The encoded filename must fit the filesystem
limit. Asset listing, backup asset selection and [sweep](#asset-mark) use this namespace. The old flat layout and the
legacy `save/database` and `save/remotes` directories have no reader or migration.

### Thumbnail cache

Derived WebP entries and deterministic original-image decisions survive restart under `cache/thumbnails/`, outside asset
listing, exports, snapshots and restore. `server/src/http/assetThumbnails.ts` `ENTRY_NAME` binds each entry to its
logical key, requested size, encoder version and source stat. `createThumbnailService` owns staging, per-key cleanup and
the post-listen sweep. A generation must keep its opened source handle until the service finishes, including if another
request replaces the key meanwhile.

### Process memory

- `assetVerification` and the locks and leases in `server/src/http/assetLeases.ts` use absolute paths across server
  contexts. A context holds the auth state, rate counters, thumbnail work, asset mark's last report, run identity and
  export holds. See [store state](server-resources.md#process-memory) and
  [job state](server-generation.md#process-memory).
- The [remote-command registry](#remote-command-routes) holds bodies until closure, then retains action identity and
  bounded results for retry. It expires entries by state and drops obsolete epochs. Restart and shutdown forget the
  registry. Notices contain identity and state, while bodies and results travel through authenticated HTTP.

## Coupling

- `Dockerfile` installs production dependencies in the runtime stage. Asset thumbnails use the `sharp` binary. An
  unavailable encoder redirects the browser to the original asset.
- The browser signs requests in `src/ts/storage/serverAuth.ts`, reads and writes through the [asset client](assets.md),
  and reaches the [Realm hub](backup-sync-hub.md#realm-access) through `hubURL`. Proxy requests originate in
  [network jobs](network-jobs.md).
- [Resource maintenance](server-resources.md#maintenance) also closes storage mutations. Imports and restores share the
  [content-name verification rule](server-resources.md#backup-and-import-internals) with asset storage.

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
- Asset publication and reuse follow the `claimAssetKey` contract in `server/src/routes/storage.ts`, including its
  restore/import exception; `/api/assets/missing` uses sorted `withAssetLocks` through verification and lease renewal. A
  handout of an existing inlay id first takes `claimInlayId`.
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
- `http/staticCache.ts` injects `__NODE__` and `__RISU_AI_DISCLOSURE__` (one script) only into the client index served
  for the root and client routes. Static serving must not return an unflagged index. The disclosure flag is part of the
  index's ETag, and the index is revalidated by ETag only: no `Last-Modified`, `If-Modified-Since` ignored, since the
  file's mtime does not change with the flag. Other static files keep `setCacheHeaders` as it is. `attachWebSocket` owns
  one Node `upgrade` listener and dispatches only the generation and live-update socket paths.
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

- `testSupport.ts` `createTestServer` is the in-process server for route and lifecycle tests: a temporary root with a
  minimal `dist/index.html`, or a reused one for a restart, with injected kinds, clocks, limits, and services.
  `testRestoreRunner` stages a restore in process, so a gate test starts no worker.
- Remote relay and presence: `pnpm --silent test:agent server/src/tests/{remoteCommands,events}.test.ts`.
  `remoteCommandOptions` injects the clock and caps through `createTestServer`.
- `assetVerification.test.ts` uses injected hashers and latches to hold file reads while fake timers control the queue.
- Boot, auth, limits, shutdown:
  `pnpm --silent test:agent server/src/tests/{app,listenConfig,shutdown,shutdownAdmission}.test.ts`.
- Storage and HTTP:
  `pnpm --silent test:agent server/src/tests/{assets,assetRoute,assetPreview,assetVerification,assetThumbnails,proxy}.test.ts`.
- Asset mark and sweep: `pnpm --silent test:agent server/src/tests/assetLifecycle.test.ts` covers retention roots,
  snapshot rechecks, and claim safety. Run its timed recognizer case through the
  [slow-test table](test-harness.md#slow-test-table).
- Ordered, durable writes: `pnpm --silent test:agent server/src/tests/{orderedWriter,durableWrite}.test.ts`.
- Diagnostics and request history coverage belongs to [diagnostics](diagnostics.md); client transport tests to
  [network and jobs](network-jobs.md).

## Known Hazards

### Limitations

- Directory fsync may be unsupported on a mount (`EINVAL`/`EPERM`); in that case a successful rename or link is not
  guaranteed to survive power loss, for the auth password and known-key files and the push subscriptions too. Decision:
  Server Byte Budgets D7, archive.
- A stalled disk holds a login, a subscription write, a share (its event barrier), and a dispose that waits for them,
  since each owes a durable answer; only the journal's own drain has a deadline (`finish`, 1 s), and its synchronous
  takeover can still block. Neither the queue nor a request is cancelled, because a hung volume already stalls the
  store's synchronous commits and Docker's stop timeout is the bound. A process that ends mid-write leaves a temporary
  file beside its target.
- `orderedWriter` frees a key and its slot only when the write settles, so four stalled keys hold every later auth,
  push, and diagnostics write; the tab's sign-in check gives up at its 20 s bound, and the registration still lands
  later. Decision: owner, 2026-11-24 (reproduction round): a stalled local file step is not bounded.
- Replacing bytes under an already cached immutable content name does not update a browser's cached asset, and a fresh
  copy stays under the [accepted exposure](#invariants). Decision: Direct Asset URLs closeout, archive.
- Swept bytes stay in a browser's immutable cache until evicted; browser-only keys are no root. Decision: Asset
  Lifecycle D11, archive.
- In `server/src/data/assetLifecycle.ts`, `sweep` calls `remark` when `store.writeCount()` changes; the default is a
  full live-reference re-mark, so even an unrelated committed write can trigger that work. The re-mark runs
  synchronously on the serving thread, so every request waits until it finishes. Decision: Asset Lifecycle D6 and D13,
  [archive](../archived-plan/README.md).
- `/api/set_password` and `/api/crypto` are unauthenticated by design and rate limited. A server has one password and
  registered browser keys, not separate users. Decision: Static Audit Fixes Q6 and Server-Owned Data non-goals, archive.
- A chunked body over the cap to the snapshot restore is not refused: the operation runs and the adapter discards the
  body ([Request bodies](#request-bodies)). The snapshot restore is authenticated. Decision: Server Byte Budgets D1,
  archive.
- An asset path lock is held through its write's file steps, and a thumbnail slot (two by default) through its native
  encode, with no caller signal: a second write to the same path or a request for the same thumbnail waits as long as
  the first, and two encodes that never finish hold every thumbnail. Other paths proceed. Decision: owner, 2026-11-24
  (reproduction round): a stalled file step or encode is not bounded.
- The thumbnail cache has no byte cap. It holds at most two sizes per asset, an asset's removal removes its entries, and
  a changed source (the key carries its stat) leaves a stale entry for the startup sweep, so it grows with the asset
  library, not without bound. Decision: owner, 2026-11-10 (known-issues review).
- JWT validation checks the registered key, ES256, the signature, and `exp`, not issuer, audience, `typ`, or `iat`: the
  browser signs its own tokens and the server issues none. Decision: owner, 2026-11-10 (known-issues review).
- `/hub-proxy` is unauthenticated: the Realm icons load it from `<img>`, which cannot carry `risu-auth`, so anyone who
  reaches the server can read the public hub through it (GET only, rate limited, an allowlist of request headers).
  Decision: owner, 2026-11-10 (known-issues review): the sandbox and `nosniff` headers on its answers are the
  protection.
- `/api/asset/*` verification is in memory and stat-based; it starts empty after restart and cannot detect an outside
  same-size edit that restores the full stat. Decision: owner, 2026-11-10 (known-issues review).

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
