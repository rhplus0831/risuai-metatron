# Self-Host Server (Hono on Node), Docker

## Scope

- Owns:
  - `server/src/**`: the Hono self-host server on Node (`@hono/node-server`). Handles static `dist`, auth, asset storage, the resource store and its routes, resource snapshots and backup archives, the reverse proxy, the hub proxy, and streaming proxy jobs over WebSocket.
  - Local TLS certificates.
  - Docker packaging.
  - The launcher scripts.
  - The client/server contract, seen from the server side.
- Paths: `server/{src/**,tsconfig.json,ssl/*}`, `Dockerfile`, `.dockerignore`, `server.sh`, `server.bat`. Domain-specific runtime semantics stay with the owner guides listed in Files and Coupling; request history and diagnostics have a dedicated [owner](diagnostics.md).
- Client counterparts, owned by other guides:
  - `src/ts/storage/serverAuth.ts` and `src/ts/storage/assetClient.ts` → `persistence.md`.
  - `globalApi.svelte.ts` `fetchNative` → `global-api.md`.
  - `characterCards.ts` `hubURL` → `characters-modules.md`.

## Files

The server is TypeScript run directly by Node's type stripping: `pnpm run server` runs
`node server/src/main.ts` on Node `>=24`; there is no server build step.
`server/tsconfig.json` strictly checks the server and its imports from `shared/`.
Routes, data, HTTP helpers, jobs, prompt processing, and tests live under
`server/src/`.

- Entrypoints: `main.ts` starts HTTP or HTTPS, installs WebSocket upgrades, starts
  background tasks, and drains shutdown; `listenConfig.ts` parses bind, storage, and
  development-auth settings; `app.ts` assembles `createServerContext`, route
  registration, state, and lifecycle. Test seams include `generationRunner`,
  `scriptWorkerOptions`, `routeLimits`, `cbsTimeLimits`, `realmStagingTimer`,
  `memoryTaskOptions`, and `thumbnailOptions`.
- Configuration: `listenConfig.ts` reads `PORT` (default 6001), `RISU_HOST`,
  `RISU_SAVE_DIR`, and `RISU_AGENT_DEV_AUTH_BYPASS`; unset `RISU_HOST` listens on
  every interface, and the auth bypass accepts `TRUE`/`1` only with a numeric loopback address (`127.0.0.0/8` or `::1`, without brackets). `parsePasswordSeed` trims and validates a 64-character SHA-256 hex string.
  `main.ts` passes `TRUST_PROXY` and sets a four-hour `REQUEST_TIMEOUT_MS`.
  `app.ts` and its route factories consume `RISU_PASSWORD_SHA256`,
  `RISU_MAX_IMPORT_BYTES`, `RISU_MAX_UPSTREAM_DB_BYTES`,
  `RISU_UPSTREAM_IMPORT_HEAP_MB`, `RISU_UPSTREAM_EXPORT_HEAP_MB`,
  `RISU_REQUEST_HISTORY_MAX_BYTES`, `RISU_DIAGNOSTICS_DIR`, and
  `RISU_DIAGNOSTICS_MAX_BYTES`.
- HTTP routes: `server/src/routes/` contains auth and storage; resource boot and
  writes; backups, upstream backups, chat checkpoints, and card imports; proxy, LLM,
  token, translation, transform, generation, memory-task, push, message-search,
  request-history, and diagnostics endpoints. The token count route aborts its
  current batch and Google request when the client disconnects. `app.ts` is the
  registration map.
- Persistence and files: `data/resourceStore.ts`, `chatStore.ts`, `kinds.ts`,
  `normalize/`, `changeFeed.ts`, `snapshots.ts`, `archive.ts`, `checkpointStore.ts`,
  `checkpointService.ts`, and `durableWrite.ts` own the database and its disk
  lifecycle. Persisted shapes, revisions, and chat mutation contracts belong to
  [persistence](persistence.md).
- Backup and import internals: `data/upstream/` reads and writes RisuAI-compatible
  `.bin` saves in workers. `http/spool.ts`, `fileImport.ts`, `contentAsset.ts`,
  `recordStream.ts`, and `routes/{backups,backupsUpstream,backupsUpstreamExport,importModule,importCharx,importPng,importRealm}.ts`
  handle archive and card file transfer. A content-named asset (`assets/<sha256 hex>.<ext>`) that
  already exists is kept only when it holds its bytes (`holdsVerifiedAsset` in
  `http/assetVerification.ts`, a recorded verification of the same file included): the module,
  CharX, PNG, and Realm imports replace an empty, truncated, or wrong file by rename, and an
  archive restore (`backups.ts` `restoreValidated`) replaces it when the archive's copy hashes to
  the name. Other existing names are never overwritten by a restore.
- Generation and prompt runtime: `jobs/` owns job admission, message locks, and the
  client channel; `prompt/` assembles and runs prompts, transformations, triggers,
  memory, and tokenization; `lua/` and `scripts/` provide the worker-backed script
  runtime. Contracts shared with the tab are covered by
  [chat-pipeline](chat-pipeline.md), [LLM requests](llm-requests.md),
  [memory](memory.md), [scripts and triggers](scripts-triggers.md), and
  [plugins and MCP](plugins-mcp.md).
- Other server services: `llm/` adapts providers and credentials;
  `translation/runner.ts` stores server-side translations ([media and auxiliary work](media-aux.md));
  `push/pushService.ts` handles Web Push (each completion to every subscription with
  `TTL` 1 h, `urgency: "high"`, and the chat's tag hash as the RFC 8030 `topic`, so
  a push service replaces an undelivered completion only with a later one of the
  same chat; a tag without a valid hash gets no topic; each outcome, with the job id the runner
  passes beside the notification, is a content-free `push` diagnostic event, see
  [diagnostics](diagnostics.md)); `data/vectorCache.ts` stores embeddings;
  `data/generationReceipts.ts` keeps the generation job receipts (State);
  `diagnostics/` owns request history, diagnostic journals, reports, and support
  shares ([diagnostics](diagnostics.md)).
- HTTP helpers: `http/{body,rateLimit,clientIp,compressedJson,staticCache,assetVerification,assetThumbnails}.ts`
  cover request limits, client IPs, caching, and asset delivery. `routes/limitedBody.ts` owns global and route-specific counting body caps. Thumbnail cache
  publication, removal, and stale-entry sweeps synchronize per key directory. See
  [global API](global-api.md)
  for the tab's transport and fetch policy.
- Packaging: `server/ssl/` generates local certificates; `Dockerfile`, `.dockerignore`,
  `server.sh`, and `server.bat` define deployment and launch behavior.
- Tests and support live in `server/src/tests/`; `testSupport.ts` builds the in-process
  server used by route and lifecycle tests. The runtime-specific guides own focused
  coverage for their domains.

The route matrix below is the server's current HTTP and WebSocket surface. Check
`app.ts` and the named route module before changing a path or its admission policy.

### Routes

Registration order in `createServerContext`:

1. `onError` (`HTTPException` responses pass through; maintenance and a closed resource store answer 503 with `Retry-After`; other errors are a 500 `Internal Server Error`). Shutdown admission middleware runs before body parsing, tracks resource handlers (`/api/resources`, `/api/llm-secrets`, `/api/chats/search`, `/api/memory/tasks`, and `/api/chat-checkpoints`), refuses new resource, message search, credential, backup, module import, CharX import, Realm import, token, and request history requests with 503, and adds `Connection: close` to every response during shutdown; every `/api/request-history` answer gets `Cache-Control: no-store` there, so a 429 or 413 carries it too.
2. `limitedBody` (100 MiB, 413 `{error:"Request body too large"}`), skipped for `POST /api/backups/import`, `POST /api/backups/import-upstream/prepare`, `POST /api/import/module`, and `POST /api/import/charx`, which stream their bodies to disk under their own cap, and for `POST /api/import/realm` and its `/commit` and `/cancel`, which cap their `{ id }` or `{ token }` body at 4 KiB, and for `POST /api/chat-checkpoints/*` and `PUT /api/chat-checkpoints/policy`, which cap their bodies at 16 KiB after authentication, and for `POST /api/chats/search`, which caps its body at 4 KiB of received bytes, and for `POST /api/tokens/count` and `/api/tokens/encode`, which cap theirs at 2 MiB after authentication, and for `POST /api/resources/read`, which caps its body at 32 MiB after authentication (the largest valid request is about 15.4 million bytes), and for `POST /api/login`, `/api/crypto`, and `/api/set_password`, which read their bodies before any authentication by design and cap them at 16 KiB. `POST /api/assets/missing` also bypasses the global cap and limits its body to 64 KiB after authentication. The global cap and the routes that cap their own bodies use the shared helper in `server/src/routes/limitedBody.ts` (the chat checkpoint routes keep their own copy over `hono/body-limit`, after authentication): a body over the cap answers 413, and a request stream that fails under it answers 400, never the app's 500, even from a route that rethrows the failed read (see Flows).
3. `GET /` and `GET /index.html` (one shared handler, with `no-cache`, a weak size/mtime ETag, `Last-Modified`, and conditional 304 responses), then the same handler for the client's screen routes: a `GET *` handler serves it when `isClientRoutePath` (`shared/routes.ts`: first segment `chat`, `playground`, `realm`, `characters`, or `settings`) matches and passes every other path on ([URL routes](app-shell.md)).
4. `createStaticCache` (`server/src/http/staticCache.ts`) checks regular files before `serveStatic` handles every other GET/HEAD: `/assets/*` gets `public, max-age=31536000, immutable`; all other files (including `sw.js` and `manifest.json`) get `no-cache`. For `.js`, `.mjs`, `.css`, `.json`, `.svg`, and `.wasm`, it negotiates fresh regular `.br` and `.gz` siblings using `Accept-Encoding` qualities (case-insensitive tokens, explicit exclusions, and wildcard; ties prefer Brotli, gzip, then identity). A missing header uses identity; missing, stale, or unacceptable siblings fall back to another acceptable representation or identity. Compressed responses stream the sibling with its own length, `Content-Encoding`, the original file's MIME type, and a weak size/mtime ETag that includes the encoding. Each representation has its own ETag and `Last-Modified`; all compressible-file responses, including identity and 304, carry `Vary: Accept-Encoding`. Matching `If-None-Match` for the selected representation (weak comparison; `*` only as the whole field) answers a bodyless 304; only when that header is absent, a parseable `If-Modified-Since` at or after mtime floored to whole seconds also answers 304. Requests carrying `Range` or `If-Range` always use identity through `serveStatic`. `If-Range` permits Range only with a matching strong ETag or the exact `Last-Modified` date; weak tags, stale validators, and invalid values discard Range and serve the full 200. HTML, including the injected index path, is never negotiated. Missing or rejected paths pass on without cache headers.
5. The routes below.

Routing is non-strict (a trailing slash matches).

| Method     | Path                                                             | Auth                                                                         | Rate limit                                                                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET/HEAD   | `dist/*`                                                         | none                                                                         | none                                                                                                           | built frontend (`createStaticCache`: Brotli/gzip/identity quality negotiation, per-encoding weak ETag, `Last-Modified`, conditional 304, `Vary: Accept-Encoding` on compressible files; fresh regular siblings only; missing/stale siblings fall back, Range/If-Range use identity through `serveStatic`; `/assets/*`: `public, max-age=31536000, immutable`; other files: `no-cache`; HTML uses identity)                      |
| GET        | `/`, `/index.html`                                               | none                                                                         | none                                                                                                           | serves `dist/index.html` with `globalThis.__NODE__ = true` injected after the `<head>` tag; `no-cache`, weak size/mtime ETag, `Last-Modified`, conditional 304 (also on screen routes); the same open handle supplies stat and text, and a missing `<head>` still throws before a conditional answer                                                                                                                            |
| GET/POST   | `/proxy`, `/proxy2`                                              | `checkProxyAuth` (stored password in `risu-auth`, or a registered ES256 JWT) | 2000/min                                                                                                       | arbitrary reverse proxy (`risu-url`, `risu-header`); with `risu-aux-op`, JWT only and one auxiliary operation (`server/src/llm/auxOps.ts`, below)                                                                                                                                                                                                                                                                               |
| GET        | `/hub-proxy/*`                                                   | none                                                                         | 2000/min                                                                                                       | proxies to `https://sv.risuai.xyz` only (path and query after `/hub-proxy`); one redirect within that origin is followed, any other redirect is answered to the browser                                                                                                                                                                                                                                                         |
| GET        | `/api/chat-checkpoints?characterId=&chatId=`                     | JWT                                                                          | 2000/min shared                                                                                                | `{ epoch, checkpoints }`, newest first; 400/404; `no-store`                                                                                                                                                                                                                                                                                                                                                                     |
| GET        | `/api/chat-checkpoints/policy?characterId=&chatId=`              | JWT                                                                          | 2000/min shared                                                                                                | 200 `{ epoch, policy: { autoEvery, autoKeep } \| null }`; 400/404; `no-store`                                                                                                                                                                                                                                                                                                                                                   |
| PUT        | `/api/chat-checkpoints/policy`                                   | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, autoEvery, autoKeep }` or `{ characterId, chatId, off: true }` → 200 `{ epoch, policy: { autoEvery, autoKeep } \| null }`; 400/404/412/413/503; `no-store`                                                                                                                                                                                                                                              |
| POST       | `/api/chat-checkpoints/save`                                     | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, name }` → `{ epoch, checkpoint }`; captures server state; 400/404/409 `generating`/412/413/503; `no-store`                                                                                                                                                                                                                                                                                              |
| POST       | `/api/chat-checkpoints/rename`                                   | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, id, baseRevision, name }` → `{ epoch, checkpoint }`; 400/404/409 with current `revision`/412/413/503; `no-store`                                                                                                                                                                                                                                                                                        |
| POST       | `/api/chat-checkpoints/delete`                                   | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, id, baseRevision }` → `{ epoch, ok: true }`; 400/404/409 with current `revision`/412/413/503; `no-store`                                                                                                                                                                                                                                                                                                |
| POST       | `/api/chat-checkpoints/load`                                     | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, id, chatBaseRevision }` → `{ epoch, chatRevision, safety }`; atomic replacement with safety summary; 400/404/409 (current `revision` or `reason: "generating"`)/412/413/503; `no-store`                                                                                                                                                                                                                 |
| POST       | `/api/generations`                                               | JWT                                                                          | 2000/min                                                                                                       | creates a generation job (`GenerationCreateBody`, optional `requestId`, `x-resource-epoch`): `{ jobId }`, or a replay `{ jobId, replayed: true, owned, status }`; 409 `requestIdReused` or `requestCancelled`; 409 `chatBusy { jobId }`, `stale`, `chatBindingIncomplete { problems }`, `chatBindingMismatch`, or `chatLoreOverrideOrphaned { entries: [{ id, name }] }`, 404, 412, 503                                         |
| GET        | `/api/generations/current?characterId=&chatId=&clientId=`        | JWT                                                                          | 2000/min                                                                                                       | read-only chat-slot lookup: `{ jobId, kind, owned, stage?, sequence? }`; optional `clientId` determines `owned`, never attaches or grants channel access; 404 `idle`, 400 invalid ids. Registered before `/:id`.                                                                                                                                                                                                                |
| POST       | `/api/generations/stop`                                          | JWT + epoch                                                                  | 2000/min                                                                                                       | `{ characterId, chatId, jobId, clientId }`: aborts only that chat's named current job, including its sequence; `{ aborted }` (false if already aborting); 409 `jobChanged`, 404 `idle`, 400 invalid ids, 412 stale epoch. `clientId` is attribution only.                                                                                                                                                                       |
| GET        | `/api/generations/:id?clientId=`                                 | JWT                                                                          | 2000/min                                                                                                       | the owner's `GenerationStatus` (404 for another client's job); after the 60 s grace a collected job's outcome still answers `state: "ended"`, `kept: true`, with a trimmed terminal, for 24 h (at most 500, oldest first out; cleared on an epoch change; disk receipts survive restart), and it can no longer be attached                                                                                                      |
| POST       | `/api/generations/cancel`                                        | JWT + epoch                                                                  | 2000/min                                                                                                       | `{ requestId, clientId }`: unknown id → `{ state: "cancelled" }` tombstone; admitted id → `{ state: "aborted" \| "ended", jobId, owned, status }`. Aborts that request regardless of owner; never stops another job in its chat.                                                                                                                                                                                                |
| DELETE     | `/api/generations/:id?clientId=`                                 | JWT                                                                          | 2000/min                                                                                                       | aborts the owner's job: `{ aborted }`                                                                                                                                                                                                                                                                                                                                                                                           |
| POST       | `/api/generations/:id/memory-stop?clientId=`                     | JWT + epoch                                                                  | 2000/min                                                                                                       | stops the owner's job's initial memory summarization run (`{ runId }`) after its summary in progress, the job going on: `{ stopped: true }`; 400, 404, 409 `jobEnded`, `noMemoryRun`, or `otherMemoryRun`, 412                                                                                                                                                                                                                  |
| POST       | `/api/generations/:id/drained?clientId=`                         | JWT                                                                          | 2000/min                                                                                                       | the owner reports a callback of its job the server cancelled as no longer running in the tab (`ChannelDrainedBody` `{ callbackId }`), freeing the client's channel lane: `{ drained }` (false when it held none; also for an ended job still kept); 400, 404                                                                                                                                                                    |
| POST       | `/api/transform`                                                 | JWT + epoch                                                                  | 2000/min                                                                                                       | the script transform (`TransformRequest`, `shared/transform.ts`): `{ results, same? }`, with `{ snapshotId, pending }` added when targets await the tab's plugin handlers; optional target `knownKey` (64 lowercase hex characters, else 400) and exact cache-hit `same` confirmations (below). 400, 404, 409 `chatBindingMismatch`, 412, 413, 503 `Retry-After: 5`                                                             |
| POST       | `/api/translate/message`                                         | JWT + epoch                                                                  | 2000/min                                                                                                       | translates one stored message on the server: `{ outcome, translation }` (`applied`, `ignored`, `fresh`); 400, 404, 409 `generating`/`chatBindingMismatch`, 412, 413, 429, 502, 503 `Retry-After: 5`, 504                                                                                                                                                                                                                        |
| POST       | `/api/memory/tasks`                                              | JWT + epoch                                                                  | 2000/min                                                                                                       | a manual memory task start (`{ characterId, chatId }`, 4 KiB): `{ outcome: "running" \| "queued", status }` or `{ outcome: "pendingManual" }`; 400, 404, 412, 413, 429 `queueFull`, 503 `notEnabled` (the runner's service disabled or replaced, tests), 503 `Retry-After: 5` (shutdown, maintenance); `no-store`                                                                                                               |
| DELETE     | `/api/memory/tasks/:characterId/:chatId`                         | JWT + epoch                                                                  | 2000/min                                                                                                       | cancels the chat's memory task: `{ cancelled }`; 400, 404, 412, 503 `notEnabled`; `no-store`                                                                                                                                                                                                                                                                                                                                    |
| POST       | `/api/transform/continue`                                        | JWT + epoch                                                                  | 2000/min                                                                                                       | the second call after the tab's plugin handlers (`TransformContinueRequest`): `{ results }`, always full answers; `same` belongs only to the first call. 400, 409 `SnapshotExpired`, 412, 503                                                                                                                                                                                                                                   |
| WS upgrade | `/api/generations/:id/ws?clientId=&attach=&liveness=&hydration=` | JWT in the `risu-auth` query or header (never the password)                  | none                                                                                                           | the owner's `GenerationEvent` stream; with `liveness=1` the tab answers each `ping` with a `pong`; with `hydration=patch` a callback barrier sends the job chat only when it changed (Generation channels)                                                                                                                                                                                                                      |
| POST       | `/api/llm/request`                                               | JWT + epoch                                                                  | 2000/min                                                                                                       | one provider request on the server (`LlmRequestBody`, `shared/llm/request.ts`); an SSE stream of `LlmRequestEvent`s; 400, 409 (`channelCall` not running; with `args.chatRef`, `chatBindingIncomplete { problems }` or `chatBindingMismatch`), 412, 429 (32 per client), 503                                                                                                                                                    |
| POST       | `/api/llm/request/:id/answer`                                    | JWT                                                                          | 2000/min                                                                                                       | answers one of the request's callbacks (`{ clientId, callbackId, outcome, value \| error }`): `{ accepted }` or `{ ignored }`; 404 for another client's or an ended request                                                                                                                                                                                                                                                     |
| POST       | `/api/tokens/count`                                              | JWT                                                                          | 2000/min                                                                                                       | `{ scope: TabTokenScope, texts }` (2 MiB, 512 texts): `{ counts }`, null only for a refused text; 400, 413, 429, 500, 503 `Retry-After: 5` (maintenance, shutdown); `no-store`                                                                                                                                                                                                                                                  |
| POST       | `/api/tokens/encode`                                             | JWT                                                                          | 2000/min                                                                                                       | `{ tokenizer, text }` (2 MiB): `{ ids }`, the tab's playground family; 400 (bad body or refused text), 413, 429, 500, 503 `Retry-After: 5` (maintenance, shutdown); `no-store`                                                                                                                                                                                                                                                  |
| PUT        | `/api/llm-secrets/<path>`                                        | JWT + epoch                                                                  | 2000/min                                                                                                       | body `{ value, baseRevision }`; sets one credential (`routes/llmSecrets.ts`); `{ epoch, revision, data }` with the masked record; 400, 409 `{ error, revision }`, 412, 503                                                                                                                                                                                                                                                      |
| DELETE     | `/api/llm-secrets/<path>?baseRevision=`                          | JWT + epoch                                                                  | 2000/min                                                                                                       | clears one credential; answers as the PUT                                                                                                                                                                                                                                                                                                                                                                                       |
| GET        | `/api/push/key`                                                  | JWT                                                                          | 2000/min                                                                                                       | `{ publicKey }`: the VAPID public key, null while push is off on the server                                                                                                                                                                                                                                                                                                                                                     |
| PUT        | `/api/push/subscription`                                         | JWT                                                                          | 2000/min                                                                                                       | body `{ subscription }` (`PushSubscription.toJSON()`, 16 KiB cap): 204; an unchanged healthy registration refreshed within 24 h answers without writing; 400 for an invalid one or an endpoint outside the allowed push services; 503 while push is off; 500 when the file could not be written                                                                                                                                 |
| DELETE     | `/api/push/subscription`                                         | JWT                                                                          | 2000/min                                                                                                       | body `{ endpoint }`: 204, also when it was not registered; 500 when the file could not be written                                                                                                                                                                                                                                                                                                                               |
| GET        | `/api/request-history?cursor&limit&…`                            | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| GET        | `/api/request-history/:id`                                       | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| DELETE     | `/api/request-history`                                           | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| PUT        | `/api/request-history/share`                                     | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| GET        | `/api/request-history/shares`                                    | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| GET        | `/api/diagnostics`                                               | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| POST       | `/api/diagnostics/report`                                        | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| GET        | `/api/test_auth`                                                 | none                                                                         | 2000/min (own)                                                                                                 | returns `unset`, `incorrect`, or `success`                                                                                                                                                                                                                                                                                                                                                                                      |
| POST       | `/api/login`                                                     | password digest                                                              | 10 per 30 s                                                                                                    | registers a public-key hash                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST       | `/api/crypto`                                                    | **none**                                                                     | 2000/min (auth bucket)                                                                                         | SHA-256 of `body.data` (text/plain)                                                                                                                                                                                                                                                                                                                                                                                             |
| POST       | `/api/set_password`                                              | **none**, only works while unset                                             | 10 per 30 s (shared with `/api/login`)                                                                         | first-run password setup                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET        | `/api/read`, `/api/remove`, `/api/list`                          | `checkAuth` (JWT)                                                            | 2000/min (storage)                                                                                             | storage. The `file-path` header is the hex UTF-8 key; `remove` takes `$$`-joined hex keys.                                                                                                                                                                                                                                                                                                                                      |
| GET/HEAD   | `/api/asset/*`                                                   | `checkAuth` (JWT)                                                            | 2000/min (storage)                                                                                             | stored asset bytes; the path suffix is the hex UTF-8 key; extension-based MIME, single byte range (206/416), conditional ETag (304), and no body for HEAD; 401 for a missing or rejected JWT, 404 for a missing or unsupported key. `?w=256` or `?w=512` selects a WebP thumbnail of the same asset, or a 307 to the original; any other `w`, an empty one, or a repeated one is 400                                            |
| POST       | `/api/write`                                                     | `checkAuth`                                                                  | 2000/min (storage)                                                                                             | storage write, raw body bytes                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST       | `/api/assets/write`                                              | `checkAuth`                                                                  | 2000/min (storage)                                                                                             | batch storage write (`shared/assetBatch.ts`): raw body of archive-framed records named by logical key, each staged, then renamed into place under the gate (overwrites); `{ success: true, written }`; 400 `Invaild Path` + `index` or `Invalid asset batch`, 503, 500, each after the body is read                                                                                                                             |
| POST       | `/api/assets/read`                                               | `checkAuth`                                                                  | 2000/min (storage)                                                                                             | batch storage read: body `{ keys }` (1-2000 keys); a chunked `no-store` octet stream of one record per key, in order, duplicates kept (zero-length for a missing file, a symlink, a non-regular file, or a key with no storage location); 400                                                                                                                                                                                   |
| POST       | `/api/assets/missing`                                            | `checkAuth` before body read                                                 | 2000/min (storage)                                                                                             | verified presence check: body `{ names }` (1-512 names, 64 KiB cap); `{ missing }` contains each unverified name once in first-asked order; non-canonical, unresolvable, absent, empty, corrupt, or over-budget files count as missing; read-only during maintenance; `no-store`; 400/413                                                                                                                                       |
| GET        | `/api/resources?kinds=a,b[&chats=1\|&chatSummaries=1]`           | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ epoch, kinds: { <kind>: [{ id, revision, data }] }, chats?, chatSummaries?, chatOrders? }`, one committed state, compressed per `Accept-Encoding` (`compressedJson`); 400 for an unknown or missing kind, or for both chat options                                                                                                                                                                                           |
| POST       | `/api/resources/read`                                            | `checkAuth`                                                                  | 2000/min                                                                                                       | body `{ refs?, chats?: [{ characterId, id }], chatCollections?: [characterId], chatSummaryCollections?: [characterId] }` (1-5000 in all); `{ epoch, items, chats?, chatCollections?, chatSummaryCollections? }` (null for a missing record or chat; summaries: no messages, memory, bookmarks, or `toolCalls`)                                                                                                                  |
| POST       | `/api/resources/boot`                                            | `checkAuth`                                                                  | 2000/min                                                                                                       | body `ResourceBootRequest` `{ kinds, chatSummaries?: true, known?: { records?, items?, chatCollections? } }` (own 2 MiB cap, 413 past it; 400 for a malformed entry, an unknown kind, or over 5000 claims); `ResourceBootResult` `{ format: 1, epoch, kinds, chatSummaries?, chatOrders?, chatSummaryFormat?, cachedChatCollections? }` with `cached` and `items` records (`resourceBoot.ts`), compressed per `Accept-Encoding` |
| POST       | `/api/chats/search`                                              | `checkAuth`                                                                  | 2000/min                                                                                                       | body `MessageSearchQuery` (`shared/messageSearch.ts`, 4 KiB); `MessageSearchPage`, `no-store`; 404 named character/chat missing, 409 `reason: "epoch"`, 429 past two running, 503 maintenance (see Files)                                                                                                                                                                                                                       |
| POST       | `/api/resources/batch`                                           | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | body `{ ops?, chats?, chatOrders? }` (1-5000 operations, nested chat ops counted, see Invariants; a resource op has exactly one of `data`, `delete`, and `patch`); `{ epoch, results, chats?, chatOrders? }`; 409 `{ error, conflicts }` with nothing applied                                                                                                                                                                   |
| GET        | `/api/resources/revisions`                                       | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ epoch, resources: [{ kind, id, revision }], chats: [{ characterId, id, revision }], chatOrders: [{ characterId, revision }] }`, no data (the live-update reconcile); compressed per `Accept-Encoding` (`compressedJson`)                                                                                                                                                                                                     |
| WS upgrade | `/api/events/ws`                                                 | JWT in the `risu-auth` query or header (never the password)                  | none                                                                                                           | the live-update stream: `hello` (epoch, generation locks, memory task statuses, optional revision-listing digest), `change`, `memoryTask`, `epoch`, `ping` (`shared/events.ts`); a matching advertised map skips the listing read; a `change` frame's patches total at most 256 KiB, and a frame that would take a socket past 4 MiB queued closes it (not the `hello`)                                                         |
| GET        | `/api/resources/:kind`                                           | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ epoch, items: [{ id, revision, data }] }` in creation order; 404 for an unknown kind                                                                                                                                                                                                                                                                                                                                         |
| GET        | `/api/resources/:kind/:id`                                       | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ epoch, revision, data }`; 404 when missing, 400 for an invalid id                                                                                                                                                                                                                                                                                                                                                            |
| PUT        | `/api/resources/:kind/:id`                                       | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | body `{ baseRevision: string \| null, data }`; `{ epoch, revision, data }` as stored; 409 `{ error, revision }` on a stale revision                                                                                                                                                                                                                                                                                             |
| DELETE     | `/api/resources/:kind/:id`                                       | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | `?baseRevision=<token>`; `{ success: true, epoch }`; 409 `{ error, revision }` when stale or already gone; 400 for a singleton                                                                                                                                                                                                                                                                                                  |
| GET        | `/api/backups`                                                   | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ items: [{ id, createdAt, size }] }`, newest first                                                                                                                                                                                                                                                                                                                                                                            |
| POST       | `/api/backups/:id/restore`                                       | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | replaces every resource with the snapshot (safety snapshot first); `{ epoch }`; 404 unknown id, 400 invalid snapshot                                                                                                                                                                                                                                                                                                            |
| POST       | `/api/backups/export`                                            | `checkAuth`                                                                  | 2000/min                                                                                                       | body `{ partial?: true \| string[] }` (`true`: profile assets selected from the archived snapshot; list: explicit asset keys); streams an archive (see Flows); 400 for invalid input or too many partial assets, 413 when it cannot fit the format                                                                                                                                                                              |
| POST       | `/api/backups/import`                                            | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | raw archive body (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`, default 16 GiB); `{ epoch, assetsWritten, assetsSkipped }`; 400/413                                                                                                                                                                                                                                                                                                |
| POST       | `/api/backups/import-upstream/prepare`                           | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | raw upstream RisuAI `.bin` body (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`): converted in a worker into a staged store, nothing replaced; NDJSON (`shared/upstreamBackup.ts`): `{ phase, done, total }` lines, then `{ token, report }`, or `{ error }`; 400 (a refused archive, a Risu Account backup's message among them), 409 (busy, or `Another RisuAI backup import is waiting for its answer`), 412, 413, 503            |
| POST       | `/api/backups/import-upstream/commit`                            | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | `{ token, acceptWrites? }`: replaces every resource with the staged store (safety snapshot first); `{ epoch, assetsWritten, assetsSkipped, selection }`; 404 `Import expired`, 409 busy or `{ error: "changedSinceReview", writes }`, 412, 400 (invalid body or staged store), 503 (the import kept on 409/412/503)                                                                                                             |
| POST       | `/api/backups/import-upstream/cancel`                            | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ token }`: removes the prepared import; 204 whether it still waited or not; 400                                                                                                                                                                                                                                                                                                                                               |
| POST       | `/api/backups/export-upstream/prepare`                           | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ promptPresetId, modelPresetId, personaId, includeSecrets, selectedChat? }`: projects one copy of the store into a RisuAI `database.risudat` in a worker and keeps it under a token; `{ token, report }` (`shared/upstreamExportReport.ts`); 400 invalid body, 409 `Other RisuAI-compatible backups are waiting for their download`, 413 when it cannot fit the archive format, 503 during shutdown                           |
| GET        | `/api/backups/export-upstream/download`                          | `checkAuth`                                                                  | 2000/min                                                                                                       | `?token=`: uses the token up and streams the referenced assets as basename records, then `database.risudat` (see Flows); 400 malformed token, 404 `Export expired`                                                                                                                                                                                                                                                              |
| POST       | `/api/backups/export-upstream/cancel`                            | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ token }`: removes the prepared export; 204 whether it still waited or not; 400                                                                                                                                                                                                                                                                                                                                               |
| POST       | `/api/import/module`                                             | `checkAuth`                                                                  | 2000/min                                                                                                       | raw `.risum` body (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`); NDJSON (`shared/moduleImport.ts`): `{ done, total }` lines, then `{ module, assetsWritten, assetsSkipped }` with each stored key in `module.assets[i][1]`, or `{ error }`; 400/409/413, 503 `Retry-After: 5`                                                                                                                                                     |
| POST       | `/api/import/charx`                                              | `checkAuth`                                                                  | 2000/min                                                                                                       | raw CharX body, a zip or a `charxJpeg` (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`); NDJSON (`shared/charxImport.ts`): `{ done, total }` lines, then `{ card, moduleData, assets, excluded }` (`moduleData` base64, `assets` entry name → stored key), or `{ error }`; 400/409/413, 503 `Retry-After: 5`                                                                                                                         |
| POST       | `/api/import/realm`                                              | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ id }` (4 KiB cap): the server downloads, validates, and stages the Realm card, writing nothing; NDJSON (`shared/realmImport.ts`): one `{ kind: "charx" \| "png", token, card, ... }` or `{ kind: "json", body }` line, or `{ error }`; 400/409 (busy, or `Too many imports are waiting`)/413, 502 (Realm's text or `Realm download failed`), 503                                                                             |
| POST       | `/api/import/realm/commit`                                       | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ token }` (4 KiB cap): stores the staged card's assets; NDJSON: `{ done, total }` lines, then `{ kind: "charx", assets, excluded }` or `{ kind: "png", image, assets }`, or `{ error }`; 400, 404 `Import expired`, 409, 413, 503 (the staged import kept on 409/503)                                                                                                                                                         |
| POST       | `/api/import/realm/cancel`                                       | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ token }` (4 KiB cap): removes the staged card; 204 whether it still waited or not; 400, 413, 503                                                                                                                                                                                                                                                                                                                             |

The live-update `hello` samples the epoch, generation locks (`streaming`), memory task statuses (`memoryTasks`) and optional `digest` in one synchronous step before registering the socket. The digest is `revisionDigest(resources.listRevisions())` (`shared/resources.ts`); a digest failure is logged without data and omits only that field, while failure of another snapshot closes the socket with 1011. A client whose seeded advertised map has the loaded epoch and matching digest reconciles from that map; otherwise it reads `/api/resources/revisions`. Nothing is replayed.

Every other frame is admitted by its own size (`routes/events.ts` `send`): a fan-out frame (`change`, `memoryTask`, `epoch`) is measured once, as the UTF-8 length of its text, and that length is used for every socket; the `ping` is measured the same way. The server does not enable permessage-deflate, so that length is the frame's payload. A socket whose `bufferedAmount` plus the frame's length would pass `MAX_BUFFERED_BYTES` (4 MiB) is terminated before the frame is queued, the other sockets still get the frame, and the client reconnects and reconciles as above; a frame that reaches the bound exactly is sent. ws's `bufferedAmount` also counts the queued frame headers (2 to 10 bytes a frame), which the admission leaves out, so an admitted frame can leave it one header above 4 MiB. The `hello` is checked on `bufferedAmount` alone: its snapshots are not bounded, and a `hello` that could never be admitted would have its client reconnect forever. What a `change` frame's patches may add is bounded by the publication budget (Flows, Resources and chats).

"+ epoch" means the `x-resource-epoch` header must name the current database epoch (412 `{ error: "EpochMismatch", epoch }` otherwise). Mutations answer 503 with `Retry-After` while a restore or an import runs. During shutdown, new resource requests (including reads), backup requests, and module and CharX imports also answer 503 with `Retry-After`; a typed store-closed error maps to the same retryable response. Every `/api/resources` and `/api/llm-secrets` response is `Cache-Control: no-store`. Every read route (`/api/resources?kinds=`, `/api/resources/read`, `/api/resources/:kind`, `/api/resources/:kind/:id`) and the PUT response answer a kind with `project` in its projected form: `llmSecrets` is masked. Every whole chat a read returns (`/api/resources/read` `chats` and `chatCollections`, `/api/resources?chats=1`) carries `streaming`: the chat's generation locks as the live-update `hello` lists them (`ChatReadRecord`, `shared/resources.ts`), taken from `generationJobs.streamingSnapshot()` in the same synchronous step as the store read, so the lock list matches the chat's revision (`[]`: no locks; a missing chat and a summary carry none). The tab replaces the chat's feed locks with it ([persistence](persistence.md) Save step 9); a client must treat the field as optional.

Chat summaries (`data/chatStore.ts` `chatSummary` over `summaryFields`, shared by the full summary listing, collection summary reads, single-chat binding reads, and a feed chat entry's `summary`) include optional `lastMessageAt`: the finite numeric `time` of the last message by position, absent for an empty chat or an undated final message. `createChatTables` memoizes both values and absence by chat seq; misses read one row through `messages_position` (`ORDER BY position DESC LIMIT 1`), never MAX(time) or an earlier dated message. Message creation/replacement, append/insert, setMessage, setText, patchMessage, removal, and translation writes invalidate it, as do chat and character cascade deletion; `replaceAll` clears the memo. While `db.isTransaction`, reads query directly and neither read nor fill the memo, so a throwing transaction callback cannot leave rolled-back activity cached. Metadata-only writes keep the memo. The resource database stays at version 3.

Ordinary send, continue, reroll, and group jobs write chat activity without changing the character or group resource revision; explicit character effects (memory enable, triggers, Lua setters) still write it. Streamed continue refreshes the continued message's time in its existing final write; non-streamed continue sets its time when writing the reply. Preview and previewPrompt change neither activity nor character revision. The stored `lastInteraction` remains a frozen legacy fallback; the client derives last-chatted ordering from chats ([persistence](persistence.md)). Upstream export keeps its independent cold-storage rule: raise a numeric legacy value to the newest chat `lastDate`, but leave absence as absence (upstream reads it as now).

Transform confirmations (`routes/transform.ts`, `prompt/transform.ts` `partitionKnownResults`): a target's `knownKey` only changes the answer for an ordinary successful cache hit with exactly that key. The first call returns `same` as a separate `{ id, key }[]` field, present only when non-empty, with no text or emotions; each target is answered once in `results`, `same` or `pending`. A different key, an evicted entry, a fresh run, `noCache`, a failure and every continuation answer in full (or await handlers on the first call). Admission and refusals are unchanged.

The resource, proxy, and job rows marked "2000/min" share one limiter; `test_auth` has its own. Login has its own. The storage rows marked "2000/min (storage)" have their own bucket with the same threshold, so an asset burst (a module import or export) cannot starve resource sync.

`/api/asset/*` answers with `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Accept-Ranges: bytes`, and `Content-Disposition: inline`, including errors and 304s. Byte responses and 304s use the extension's MIME from `shared/assetMime.ts`, including `flac` as `audio/flac` and `mkv` as `video/x-matroska` (unknown types: `application/octet-stream`); `html`, `htm`, `xhtml`, `xml`, `js`, and `mjs` use `attachment` and `application/octet-stream`, while SVG stays inline under the CSP sandbox. Successful responses and 304s are `Cache-Control: private, no-cache` with a weak ETag unless the content name is verified against the stat of the handle supplying the bytes. Verified names use `Cache-Control: private, max-age=31536000, immutable` and the strong ETag `"sha256-<hex>"` on 200/206 responses. A verified name accepts either its strong tag or its current weak stat tag in `If-None-Match`; a 304 carries the tag that matched and the immutable Cache-Control, so revalidating an earlier weak-tagged copy upgrades its caching policy. Comparison is weak for both tag forms, lists, whitespace, and a lone `*`; a strong-tag match takes precedence when both tags match. The weak ETag uses size, nanosecond mtime, and inode; a matching `If-None-Match` takes precedence over Range. Errors remain `no-store`. A single satisfiable `bytes=` range gets 206 with `Content-Range` and its length; an unsatisfiable range gets 416 with `Content-Range: bytes */<size>`. HEAD ignores Range and returns the full length (or 304); empty files ignore Range and return an empty 200.

`POST /api/assets/missing` awaits `assetVerification.verifyFiles`: at most four asynchronous streaming hashes at once and 256 MiB of reads per request, with budget reservations in name order. It opens regular, non-empty files without following symlinks and reuses verified or mismatched results only against a fresh handle stat. Unknown files larger than the remaining budget count as missing. Each hash reads at most its reserved size; changed handle stats or pathname identity (size, nanosecond mtime, inode, device) make the file missing. Writer and forget generations prevent an older check from overwriting a newer verification or reporting it present. Only a digest matching the canonical name is present; corrupt files are missing so uploads repair them. Aborting stops new hashes. The read-only check remains available during maintenance.

The thumbnail variant (`?w=256|512`, the short side's size class, not the output width) keeps the route's limiter, authentication before any file access, security headers, and the open-once rule: the route opens and stats the source once and hands that handle and stat to `assetThumbnails.ts`, which never reopens the source path. A WebP answer is `image/webp`, `inline`, served from the cache file with the same Range, HEAD, and 304 rules as the original. Its tags carry the size and transform version so they never equal the original's, another size's, or another version's: a verified source gets `"sha256-<hex>-w<size>-v<THUMBNAIL_VERSION>"` with the immutable Cache-Control and also accepts its current weak tag (a 304 then upgrades that copy); any other source gets `W/"<size>-<mtimeNs>-<ino>-<dev>-w<size>-v<THUMBNAIL_VERSION>"` with `private, no-cache`. A concrete variant-tag match answers 304 before the service runs, with no decode; a lone `*` goes through the service and applies to a WebP outcome only. When the original should be shown (the short side is at most the size, an animated GIF or WebP (`pages > 1`) or a PNG with `acTL` before its first `IDAT`, a source that is not a PNG, JPEG, GIF, WebP, or AVIF or that sharp reports as an unsupported format, an empty source, or one over 32 MiB or 40 megapixels) the answer is `307 Temporary Redirect` to the relative, query-free `/api/asset/<hex>` with `x-risu-thumbnail: original`, no ETag, and the original's Cache-Control (immutable when verified, else `private, no-cache`); preconditions are ignored, so it is never a 304. The encoder failing to load, a full generation queue, or any other service error (I/O, memory, encoder) answers the same redirect with `x-risu-thumbnail: unavailable`, `busy`, or `error` and `Cache-Control: no-store` (`error` also logs a line); a thumbnail failure is never a 5xx. The browser and the service worker follow the redirect to the original, so a page needs no status handling.

## Flows

Boot:

1. `pnpm run server` starts `main.ts`; `readListenConfig` resolves the port, host,
   save directory, and loopback-only development auth bypass.
2. `createServerContext` creates the save directory and server state, then `serve()`
   listens with HTTPS when `server/ssl/certificate/server.key` and `server.crt` exist.
   The context attaches WebSocket handlers and starts snapshot, diagnostics, and job
   background tasks.
3. Shutdown stops admissions and timers, drains HTTP for up to eight seconds, closes
   remaining connections, then awaits `dispose()` before exiting.

The server serves a flagged `index.html` for the root and client routes; `__NODE__`
lets the client mount only when this server is present. Client boot, auth, and dev
proxy setup are documented in [app-shell](app-shell.md) and
[build-test-platforms](build-test-platforms.md).

Auth:

1. The tab stores an ES256 key pair in IndexedDB and calls `/api/test_auth`. On
   first setup it posts the password digest to `/api/set_password`, then logs in;
   otherwise it calls `/api/login`. The server registers the public-key hash and
   returns a short-lived JWT.
2. Later HTTP and WebSocket requests carry that JWT. The optional initial
   `RISU_PASSWORD_SHA256` seeds only a missing password file. `RISU_AGENT_DEV_AUTH_BYPASS`
   is accepted only for a numeric loopback host.
3. JWT input failures answer 400; malformed tokens and token parse/crypto exceptions
   use `{ error: "Invalid Signature" }`. The asset route still rewrites auth failures
   to 401. Token acceptance rules are shared with WebSocket authentication.

Request bodies use `routes/limitedBody.ts` for both the global cap and route-specific
caps. The limiter counts and does not buffer: a declared `Content-Length` over the cap
is an immediate 413 with nothing read, and any other body reaches the route at once as
a demand-driven stream that reads its source only when the route reads. A route that
answers before reading (a failed auth check) therefore costs no body. After the route
has run the limiter assigns `c.res` from what it recorded: 413 past the cap (overflow
wins), otherwise 400 `{ error: "Invalid JSON body" }` (or the route's configured read
error) when the stream failed under the cap, whatever the route answered or threw
meanwhile, `Cache-Control` and `RateLimit-*` kept and the route's other headers dropped.
With neither fact the route's own answer stands, an error included. A route's read
fails with `RequestBodyError`, an `HTTPException`, so `app.onError` logs nothing for it.

Three consequences follow. A route that never reads its body (the snapshot restore)
refuses an over-cap one only by its declared length; the body is discarded with the
connection. A route must finish reading before it exposes a streamed response, because
an overflow found later cannot become a 413; every route under a cap does. And the
source is not read past the overflow: a client still sending gets the 413 and the
connection closes 500 ms later (`@hono/node-server`'s cleanup stalls behind the abandoned
reader), except on `POST /api/assets/write`, which drains first.

The asset batch publishes each completed record by rename while the upload is still
being read, so its failures are partial by design: at the first failure the staged file
is removed, the rest of the body is read and dropped, and records renamed before it stay.
An over-cap chunked batch is such a failure: its earlier records may be published when
it answers 413 (a declared length over the cap publishes nothing), and that is the same
outcome as an upload that fails midway.

Local model refusals preserve the status from `prompt/transformers.ts`
`localModelRefusal`: a full queue answers 429, an expired queue wait answers 503.
Prompt jobs and manual trigger commands both use that mapping; server translations
preserve the refusal status carried by a failed WebLLM request.

Resources and chats:

- The boot read returns the current resource epoch and a coherent view of requested
  resources and chats. The client save adapter batches resource, chat, and order
  changes through `/api/resources/batch`; conflicts roll the batch back.
- Chat mutation addresses and conflict recovery are shared client/server contracts;
  see [persistence](persistence.md). The server-specific checkpoints live in
  `checkpointService.ts`: a load checks the current chat and generation locks, takes
  a safety checkpoint, applies the replacement transactionally, sets the restore
  floor, and invalidates retained memory-task input. Automatic checkpoints run only
  after a job ends with a final `done`, when the chat policy's user-turn threshold
  is met.
- Group ids: a chat group whose id its chat incarnation remembers returns its
  earlier result without applying again or publishing a chat feed ref. Duplicate
  tracking stays internal; the HTTP response shape is unchanged. A newly applied
  group publishes its chat ref as usual.
- Own chat changes: a server writer that passes `changes: true` with its `committed`
  hook to `applyChanges` gets `committed(applied, written)`. `written.chats` is aligned
  with `applied.chats`: each by-id group's change as stored (`ChatWriteChange` in
  `chatStore.ts`: the stored revision right before the group, even for a stale group,
  and the revision after it; the message count; the ids it removed that were there
  before it, in removal order; every row it touched as its stored `data` string with
  the id of the row before it, in position order; the stored `meta` string when it
  changed the metadata). It is `undefined` for a group without a by-id change: a
  create, replace, or delete, a remove and reappend of one id, a remembered group, or
  a group that applied nothing. The change is uncapped and built only for a writer
  that asks: the feed keeps its capped patch or delta (taken from that change, and
  subject to the publication budget below, which leaves `written` as it is), a write
  without the option still stops reading at the feed's byte cap, and the HTTP batch
  body is unchanged.
- Feed chat entries (`ChangeSet.chats[]`, `shared/resources.ts`; built in `chatStore.ts`
  `applyGroup` and kept in a feed-only map by group result, never in `ChatGroupResult`,
  the HTTP body, or `ChatWriteChange`): every by-id group that applied something
  carries what it knows about the chat's summary, and its by-id change when that fits.
  - Summary: `summary` (the chat's summary at the group's revision) when the group
    changed it, else `summaryBase` (the group's stored base revision: the summary, its
    `revision` aside, is the same as there). Both parts are compared, never the
    revision: the listed metadata fields (parsed only when the group changed the stored
    metadata string) and, for a group with a message op, `lastMessageAt` right before
    its first one (taken even when absent) and after the group, read inside the
    transaction (never from the memo), so a note edit with a removal of the last row,
    or an op that leaves no dated last row, counts. A changed summary of a group without
    a message op reads the time once to be complete. A remove and reappend carries it
    too. A whole-chat write, a remembered group, a no-op group, and a deletion carry
    neither: unknown, which keeps the client's summary-list read.
  - By-id change (`chatFeedChange`): one pass over the stored parts. A `patch` with the
    metadata whole when it fits `MAX_FEED_PATCH_BYTES`; at the first byte over, a group
    that changed the metadata switches to a `delta`, whose `metaFields` (`ChatMetaFields`)
    is the field diff of the stored metadata before and after the group (never the ops:
    a stale group merges onto the stored base and normalization rewrites the result):
    top-level fields `set` or `remove`d, and for a `CHAT_META_MERGE_KEYS` field that is a
    map on both sides its entries by `merge`/`mergeUnset` (a field that becomes or stops
    being a map, or appears or disappears, goes through `set`/`remove`), with the rows
    already read and the same row iterator. Neither when that does not fit either. An
    entry carries at most one of the two; the job socket's `chatPatch` keeps the whole
    `meta`. A write without `changes: true` still reads rows only while a form fits (an
    over-cap metadata is parsed for its field form, never the rows past the cap).
  - Coalescing (`resourceStore.ts` `coalescedChat`, for a chat recorded again in a
    publishing scope and for nested scopes in `mergeChanges`): the later ref without a
    patch or delta; the later `summary`, else the earlier `summary` moved to the later
    revision when the later entry's `summaryBase` is the earlier revision, else (both
    unchanged in a row) the earlier `summaryBase`; otherwise neither. Entries are never
    changed in place, since a failed outer write merges its committed nested scopes
    again.
- Change feed events reach listeners in publish order, including events a listener
  publishes while handling another event. Listener failures are logged and the
  feed continues draining. Committed nested writes still publish their refs when
  an enclosing write fails during input evaluation.
- Publication budget: one committed outermost write is one `change` frame
  (`feed.publish` once), and the optional payloads of that frame (record `patch`es,
  chat `patch`es and `delta`s, each within `MAX_FEED_PATCH_BYTES`, 64 KiB, when built,
  and chat `summary` and `summaryBase` fields) total at most
  `MAX_FEED_PUBLICATION_PATCH_BYTES` (256 KiB of UTF-8 JSON, `shared/resources.ts`).
  The store applies it only when the outermost publishing scope publishes
  (`resourceStore.ts` `budgetedEntries`): after nested scopes merged, after coalescing
  dropped the patches and deltas of keys recorded twice, and after a failed outer write
  kept only its committed nested writes. A nested scope neither spends nor resets it,
  and a feed listener's own write is a later publication with a budget of its own. The
  walk takes the final entries in wire order (resources, then chats; chat orders carry
  no payload), and within a chat entry its `patch` or `delta` before its `summary` or
  `summaryBase` (each measured as its own JSON, a `summaryBase` with its quotes): a
  payload stays when the running sum including it fits, otherwise its entry is
  published as a copy without it in the same place (a dropped `summary` leaves neither
  summary field, so the entry's summary is unknown) and the walk goes on, so a later
  smaller payload can still fit. Every candidate payload is measured, so the cost
  follows the payloads the write built, not the frame. Refs, chat-order entries, and
  `streaming` lock lists are never dropped, reordered, or split, so a chat's locks stay
  in the frame of its chat ref and a lock release with no refs (`publishStreaming`) is
  still published.

Generation admission and request identity:

- After the route's limiter, authentication and body validation, `create` checks the epoch,
  synchronizes the identity maps and receipts with that epoch, and looks up `requestId` before
  checking shutdown/maintenance/the gate, hooks, chat existence, the chat slot, revision, binding,
  and orphaned overrides. Lookup through slot and request-index installation is synchronous;
  the runner starts on a later microtask, so identical simultaneous requests admit once.
- `requestId` matches `GENERATION_ID_PATTERN`. The server fingerprints exactly `kind`,
  `characterId`, `chatId`, `command`, `input`, `userMessageId`, and `continueMessageId` with
  SHA-256 over recursively sorted JSON keys (array order preserved, absent fields null).
  Revision, binding ids, hooks and client id are excluded. A body without an id still admits
  normally, without deduplication, with the epoch checked before the gate.
- Lookup reads current-epoch live jobs (including ended jobs in grace), then kept identities,
  cancellation tombstones, then disk. A matching fingerprint returns 200 with the original job
  and its status, even if ordinary admission would now refuse. `status: null` means its payload
  was pruned. Another fingerprint returns 409 `requestIdReused`; a tombstone returns
  `requestCancelled`. Ownership is client-id equality; a non-owner's status is a copy without
  `terminal.result`. GET/DELETE by job id, sockets and callback routes remain owner-scoped. The chat-slot `GET /current` and `POST /stop` are available to any authenticated tab or device.
- Cancel is idempotent: a running request is aborted, an ended request is left intact, and an
  unknown request receives a tombstone in memory before its best-effort disk write. Cancelling
  again preserves the timestamp. An abort acknowledgement is not a terminal; the runner still
  has its existing abort grace to save and end. Cancel also works during maintenance/shutdown.
- A retry's auth, limiter or body-reader failure happens before lookup. After an unanswered
  create, only a decoded registry success/replay or a refusal that fences the delayed original
  resolves that exchange: `requestCancelled`, `requestIdReused`, `stale`, `chatBindingMismatch`
  and 404. A refusal installs no identity, so after one the original can still be admitted:
  the 503s, `chatBusy`, `chatBindingIncomplete` and `chatLoreOverrideOrphaned` keep the request
  uncertain, as do 412, 429, auth/body-limit errors and generic errors.
  This does not bypass the shared limiter or promise connectivity after the listener closes.

Command sequences:

- `prompt/commands.ts` parses `/multisend`; `jobs/runSetup.ts` queues its clear flag and texts in
  server-local run state for command jobs, with at most `MAX_SEQUENCE_PARTS` (64) parts of at most
  `MAX_SEQUENCE_PART_CHARS` (100,000) characters. An over-limit command raises an `alertError`
  notice and queues nothing. Inside a send it does nothing.
- `jobs/commandRunner.ts` runs queued parts after a Lua button, form, or manual trigger finishes,
  keeping one id, chat slot, channel, owner and hooks. Before each part, the registry synchronously
  checks abort, the previous deadline, shutdown, maintenance/gate, epoch, chat existence, complete
  binding equal to the admitted context, and orphaned lore overrides. A preset-chain pick never
  changes that comparison. Neither the occupied slot nor the original chat revision is rechecked.
- With no await after that check, one token-owned chat write removes all messages when clear is set
  (omitted for an empty chat) and appends the user part with a fresh message id and no timestamp.
  The owner receives the chat after the write. A refusal writes nothing for that part.
- `prompt/runner.ts` `runPromptSend` runs each part as a normal send with empty input, so no input
  trigger or `editinput` runs. Its send view retains registry methods and signal, removes the
  command's trigger/speaker/message ids, and uses fresh run state and script budget while carrying
  the emotion history forward. Pending metadata is flushed before changing views. Each part has
  its own generation ids, reply locks, stages and request-history rows; translation and memory
  hand-offs occur before it returns. Deleted reply locks are released without ending the job.
- `JOB_MAX_DURATION_MS` (30 minutes) applies anew to each admitted part; an already-expired
  deadline aborts instead of resetting. Total diagnostic duration still starts at job admission.
  After a part returns, the job updates memory and best-effort receipt progress, then sends the
  live-only `sequence` event (`index` is zero-based, with `total`, `sent`, and optional reply id and
  alternatives). A removed reply counts as sent; a send returned stopped does not.
- The one terminal carries `sequence: { total, sent, stopped? }`: boundary refusals and a returned
  stopped send end done with the refusal code or `notSent`; thrown errors and registry aborts keep
  error terminals with the current progress. The first abort still wins. A command with no queued
  parts has no sequence. Auto-checkpoint runs once after a done sequence with an attempted part,
  after the slot is released; it cannot run between parts. Parts needing no browser callback
  continue without the page; a needed callback uses the channel's existing absence rules.

Generation channels:

- `current` reads `chatSlots`, including command jobs with no generation lock. It never attaches,
  changes ownership, or enables callback answers. `stop` checks the epoch, compares the current
  slot with the confirmed job id, and aborts synchronously. An idle chat answers 404; a replacement
  answers 409 `jobChanged` and must be looked up and confirmed again. The first abort decides:
  only an explicit stop by a different `clientId` adds `abortedBy: "other"` to the error terminal
  and `stoppedBy: "otherClient"` to the diagnostic end event. These remain reason `aborted`, not
  failures; request-id cancel and owner DELETE stay unattributed. The abort ends the whole command
  sequence through the existing abort path, retaining its progress and attribution in kept outcomes.

- The tab attaches `/api/generations/:id/ws` with `liveness=1` and answers every
  `{ type: "ping", ts }` with `{ type: "pong", ts }`, echoing `ts` before checking the
  event epoch. The registry uses its own clock: a negotiated socket with no incoming
  frame for `OWNER_SILENT_MS` (45 s from attach, then its last frame) is removed from
  the owner set before being closed. Socket events and owner-presence reads check
  silence too, so a late timer or frame cannot revive it. MCP sees the same effective
  owner presence. Sockets without the query retain the compatibility rule below.
- `ownerAbsentSince` starts at admission, clears at attach, and starts again when
  the last effective socket leaves. Silence starts absence at the silence deadline,
  even if detected later; a superseded socket's close does not change it. Each
  dispatched question or callback uses the minimum of its own deadline, the job's
  absence deadline (`ownerAbsentSince + OWNER_ABSENT_MS`, 120 s), and its parent's
  effective deadline. Owner transitions re-arm channel wakeups. The registry and
  its default hub share the injected `now` clock; `ownerAbsentMs` / `ownerSilentMs`
  are test overrides, forwarded by `app.ts` as `generationOwnerAbsentMs` /
  `generationOwnerSilentMs`.
- Answers, chunks, dispatch, attach, parent lookup and `watchCallback` check the
  effective deadline. Attach expires overdue requests while still absent, then
  clears absence, sends its snapshot and replays requests still open. Reconnecting
  within the wait removes the absence cap without extending a request's own
  allowance. Absence expiry settles `disconnected` through the existing path,
  including that client's ownerless queued roots opened no later than the expired
  root's dispatch. A queued root also wakes at its own job's absence deadline (its own
  timeout still starts at dispatch), and an attach after that deadline settles it
  `disconnected` instead of delivering it; a never-dispatched root gets no `cancel` and
  no drain hold. Delivered callbacks keep their drain holds; socket departure
  never releases them or changes `/drained`. There is no job-wide absence abort:
  callback-free sequence parts and detached memory tasks keep running.
- On attach, buffered notices, outstanding request replays, and first deliveries
  of requests promoted by an expiry are sent in their original request/notice
  order. A promoted request joins that ordered batch and is sent once.
- The owner's job chat `chatPatch` is the diff (`diffChat`) of two stored states of the job chat:
  `sentChat`, the last copy a socket took (seeded at admission; a successful `send` advances it,
  with no acknowledgement from the tab), and `workingChat`, the chat as the job's own writes left
  it. `writeAsJob`'s `committed` hook advances `workingChat` by each own write's `ChatWriteChange`
  (`applyChanges` with `changes: true`) when the change starts at its revision, placing the rows as
  the scope's adoption does (`messageOrderAfterChange`); a write without a by-id change, a change
  that starts at another revision (another writer's write landed first), or one that does not fit
  sets it to null. A patch-mode job chat event reads only the chat's revision while `workingChat`
  is at it and parses only the carried rows; otherwise it reads the chat whole, and that read
  becomes `workingChat` while the job runs. A checkpoint with no open socket advances only
  `workingChat`, so the next attach's patch carries every checkpoint since `sentChat`. A `resync`
  sends the chat whole; the end clears both baselines.
- The callback barrier (`hydrateAll`, run when a `callback` event is built, replays included)
  first flushes the job's pending own write. When the owner socket attached with
  `hydration=patch` and a socket took a copy (`sentChat` is set; `hydrateJobChat`), it then reads
  the job chat's revision once: still `sentChat`'s, it sends no chat event and the receipt names
  that revision; otherwise it sends the patch-mode job chat event (a `chatPatch` from `sentChat`,
  or whole) and its receipt. A socket without the flag (an older tab) gets the chat whole on every
  callback. Every other record the job sent goes fresh as before. The skip relies on the job's `streaming` list not changing while the revision stays:
  watermarks move only with an applied checkpoint, and the one lock release without a chat write
  (`releaseRemovedReplies`) is followed by the job's end or the next sequence part's writes, which
  precede that part's callbacks.
- A callback's client barrier flushes local work and retries the job's remembered
  hydration copies. When the job chat's receipt is still not held (no remembered whole copy, an
  older one, or one refused by the acknowledged floor), it makes one whole resource read of the
  job chat, even while streaming, fenced on the callback, epoch, chat owner and incarnation, and
  job metadata, and installs it with the job's newest held `streaming` list. Normal hydration
  admission still protects local work and the floor; the callback runs only when the client holds
  every receipt or a newer revision ([persistence](persistence.md)).

Snapshots and backups:

- The snapshot timer runs every ten minutes and writes only after committed resource
  changes; it retains the newest 20 snapshots. Restore validates the snapshot and
  epoch, then under maintenance makes a safety snapshot and replaces the resource
  store, advancing the epoch.
- The version-2 archive export streams a database snapshot and asset records; its
  exported database omits `llmSecrets`. Import authenticates and checks the epoch
  before reading, spools and validates the full archive, then installs it under
  maintenance with a safety snapshot and only adds missing asset files.
- Upstream `.bin` import and export use prepare/commit or prepare/download flows.
  Conversion runs in a worker with a heap cap; staged work expires after ten
  minutes. Import reports changes for review and checks that the live store has not
  changed before commit. Export reads the snapshot without checkpoint tables, so
  upstream saves do not include named checkpoint history.
- `.risum`, CharX, and Realm imports validate before publishing assets. Module and
  CharX uploads spool to disk; once their NDJSON response starts, failures are
  returned as a final error line. Realm import stages card contents before the tab
  commits its assets, and shares one import slot with module and CharX imports.

Maintenance closes new resource and storage mutations and waits for admitted writes.
Restore and backup imports use the maintenance gate; the route table records which
operations carry an epoch and which upload paths bypass the global body cap.

Proxying:

- `/proxy` and `/proxy2` forward arbitrary upstream requests. They preserve raw
  request bodies, strip hop-by-hop and `risu-auth` headers, and keep the timeout
  active through response streaming; a client disconnect aborts the upstream call.
- `/hub-proxy/*` targets the configured Realm hub only. It is unauthenticated and
  does not forward `risu-auth`.
- Server local-network streaming runs as a generation job over WebSocket. Its target
  must pass the server's local-network URL policy; job deletion, deadline, garbage
  collection, shutdown, or client disconnect aborts the upstream stream. See
  [LLM requests](llm-requests.md) for request dispatch and [plugins and MCP](plugins-mcp.md)
  for plugin providers.

## State

Disk, under `save/`:

- `server/password`: the client-side SHA-256 digest via `/api/crypto`. Only a missing file opens setup (`ENOENT`; other read errors throw). An empty or whitespace-only file logs a warning and keeps setup and password login closed until the operator fixes or deletes it; registered JWT keys still work, and `/api/test_auth` checks them rather than returning `unset`. `RISU_PASSWORD_SHA256` can seed a missing file durably at startup, never overwrites an existing file (even an empty one, with a warning that the seed was ignored), and changing the variable never rotates an existing password.
- `server/known_public_key_hashes.json`: an array of strings. A missing file means no known keys; malformed JSON or another shape (including an empty file) is renamed beside it to `known_public_key_hashes.json.corrupt-<Date.now()>`, with a warning naming that path. Startup continues with no known keys, so every tab logs in again with the password; other read errors throw. Deleting only `password` lets you set a new one but does not revoke registered clients; delete this file too for that.
- `server/web_push_vapid.json` (mode 600): the Web Push VAPID pair. Replacing it (or the `RISU_WEB_PUSH_VAPID_*` variables) leaves every browser subscribed with the old key: each subscribes again the next time it opens the app, or an open tab's page is shown again.
- `server/push_subscriptions.json` (mode 600): `{ version: 1, subscriptions: [{ endpoint, keys: { p256dh, auth }, expirationTime, failureCount, lastError?, updatedAt }] }`; `updatedAt` is the last registration refresh, at most once per 24 h for an unchanged healthy entry. Skipped registrations leave the stamp and list order unchanged; the 50-entry cap drops the least recently refreshed.
- `.tmp/`: staged writes and the per-operation export/import staging folders, emptied at startup.
- `data/resources.sqlite` (plus its `-wal` and `-shm` files): the resource store. Table `resources` (`seq` autoincrement, `kind`, `id`, `revision`, `schemaVersion`, `data` JSON text, unique `(kind, id)`), table `meta` holding the random `epoch`, table `chats` (`seq`, `characterId`, `id`, `revision`, `schemaVersion`, `meta` JSON), table `messages` (`chatSeq`, message `id`, integer `position`, `data` JSON, and the generation fence: `generationId`, `generationSeq`, `generationFinal`, `generationHistory` of up to 8 earlier ids), table `chatOrders` (`characterId`, `seq`, `revision`, `ids` JSON), and table `chatGroups` (`seq` autoincrement, `chatSeq` referencing `chats.seq` with `ON DELETE CASCADE`, `groupId`, `revision`, `result` JSON, unique `(chatSeq, groupId)`), which `createChatTables` creates when missing, so a version-3 file from before it gains it on open without a version change; it is not part of the snapshot layout check, a snapshot's copy of it is not restored, and a restore leaves it empty (deleting the chats cascades). The checkpoint tables are created the same way and are outside the required layout (a snapshot without them is valid), but a snapshot that has any of them is checked and restored with them (`readCheckpointSnapshotRows`): `chatCheckpoints` (`seq` autoincrement, `chatSeq` referencing `chats.seq` with `ON DELETE CASCADE`, `id`, `kind` (`manual`, `auto`, `safety`), `name`, `createdAt`, `revision`, `chatRevision`, `userTurns`, `messageCount`, `preview` JSON, `pages` JSON (the ordered message page hashes), `fields` JSON (captured field → page hash), unique `(chatSeq, id)`), `checkpointPages` (`hash` primary key, `text`), `checkpointPageRefs` (`checkpointSeq` referencing `chatCheckpoints.seq` with `ON DELETE CASCADE`, `hash`, indexed), and `chatCheckpointPolicy` (`chatSeq` primary key referencing `chats.seq` with `ON DELETE CASCADE`, `autoEvery`, `autoKeep`, `lastAutoTurns`); a page no ref names is swept at open and in every checkpoint delete and prune, and a restore keeps only the snapshot's referenced pages, so a deleted chat's pages wait for the next sweep; `PRAGMA user_version` is the store version (3: settings sections and collections, no `root` record; the tables are those of version 2). Opening the store and every `replaceAll` run the normalization pass in one transaction: each record whose normalized text or schema version differs from the stored one is rewritten with its revision counter advanced (same `seq` and epoch), and each missing `materialize` singleton is created; a stored record its normalizer rejects, or one of a newer schema version than its kind, stops the start. A version-1 file or version-2 file (settings in a `root` record) is refused at startup with a message naming it, and a snapshot or archive of another version is refused on restore; there is no migration (formats of metatron's implementation phases, `persistence.md` compatibility rule). The connection runs with `journal_mode=WAL`, explicit `synchronous=FULL`, `busy_timeout=5000`, and `foreign_keys=ON`, so acknowledged resource writes do not depend on the SQLite build default. Request history and the vector cache keep `synchronous=NORMAL`. `data/` is not a storage namespace.
- `data/generation-jobs.sqlite` (plus its `-wal` and `-shm` files): the generation job receipts (`data/generationReceipts.ts` `createGenerationReceipts`). Like the request history it is in no snapshot or archive, and `data/` is not a storage namespace.
  - Table `receipts`, one row per job: `job_id` (primary key), `request_id` and `fingerprint` (null for older clients; unique `(epoch, request_id)`), `client_id`, `epoch`, `kind`, `character_id`, `chat_id`, `admitted_at`, `ended_at` (null while the job runs; indexed), `progress` (the sequence's `{ total, sent }` JSON, otherwise null), and `status`, the kept `GenerationStatus` JSON with the same trim as the in-memory kept outcome. `PRAGMA user_version` is 1; a file of another version is left untouched and the store runs degraded. WAL with `synchronous=NORMAL`.
  - A cancelled request uses the same table: `job_id = "cancel:" + requestId`, private `kind = "cancelled"`, empty character/chat ids, `admitted_at = ended_at` at cancellation, and null fingerprint/status/progress. It is never served by a job-status read and is pruned with compact rows.
  - Writes: the registry upserts a row synchronously at admission and at the job's end (every terminal path: done, error, abort, timeout, shutdown, maintenance), and writes sequence progress before the first part (`sent: 0`) and at each completed part boundary before its event. Reads: a status answers from memory first (the live job, then its kept outcome); the disk answers only an id memory does not hold, only to the row's `client_id`, and only in the current epoch. Request lookup is shared across clients and returns the identity even when its status payload is gone. Lookup, admission and cancel synchronously delete an expired matching request row before reusing its unique key, never replacing a live identity.
  - At open, rows of another epoch are deleted and every running row is ended as a kept `{ type: "error", reason: "shutdown", status: 503, message: "The server stopped while this job ran" }`, keeping its `progress` and including it as terminal `sequence` when it is a valid object of non-negative integer `total` and `sent`, with `sent <= total`; this runs once per open. Remaining parts are not resumed. An epoch change (the maintenance end, or the registry noticing it at a status read, an admission, or the GC tick) deletes the old epoch's rows in one transaction.
  - Retention, pruned on the 30 s GC tick in bounded transactions: a row's `status` is cleared 24 h after its end (`KEPT_OUTCOME_MS`, also checked at every read, so an expired payload never reads back before the prune) or when it is not among the 500 newest payloads (`MAX_KEPT_OUTCOMES`); the compact row stays 72 h after its end (`GENERATION_RECEIPT_MS`), at most 10,000 rows (`MAX_GENERATION_RECEIPTS`, oldest end first). A running row is never pruned.
  - Degraded mode: a failure to open, write, read, sync or prune closes the connection for the rest of the process. The disk is no longer read or written, jobs are admitted and end as before, the in-memory kept outcomes go on, and the failure is one content-free `runtime` event (origin `generation.receipts`).
- `backups/`: resource snapshots (`resources-*.sqlite`, single files, newest 20), not a storage namespace. Assets are not in snapshots.
- User files: a logical key `assets/<name>` lives at `save/assets/<encodeFileName(name)>`, e.g. `assets/<sha>.png` or `assets/inlay_<sha256>.png`. The legacy `save/database` and `save/remotes` folders are left in place and no longer read.
  - `encodeFileName` keeps `a-z 0-9 . _ -` readable and writes every other UTF-8 byte (uppercase letters, `/`, `%`, spaces, non-ASCII) as `%XX`. It also escapes a trailing dot and the first character of a Windows device name (`con.png` → `%63on.png`). A name whose readable form exceeds 255 bytes is stored as `~<lowercase hex>`; longer than that is rejected.
  - Only one encoding per name is canonical, and canonical names never differ by case alone, so case-insensitive filesystems do not merge keys.
  - The old flat layout (hex file names and `__password` directly in `save/`) is not read and was not migrated.
- `cache/thumbnails/<sha256(key)>/<entry name>`: the asset route's derived WebP thumbnails, with each key directory created when an entry is ready to be staged. Each entry is `<sha256(key)>-w<size>-v<THUMBNAIL_VERSION>-<size>-<mtimeNs>-<ino>-<dev>` plus `.webp`, or `.orig` (an empty marker for a deterministic "serve the original" decision: small, animated, non-raster or unsupported, or over the input caps; never for a transient failure). Entries are staged under `.tmp/` and renamed into place, outside the maintenance gate. Publication and removal touch only that key's directory: after publishing, the service lists it and drops entries whose identity differs from the source file's current stat (all of them when the source is gone, including the one just written), removing the directory if empty; `/api/remove` removes the directory. A sweep after listen (`startBackgroundTasks`, aborted at shutdown) walks key directories and drops non-regular entries, entries of a missing or changed source, entries of another `THUMBNAIL_VERSION`, and entries with an unknown name or a hash that differs from their directory, then removes empty directories. It removes anything else at the top level, including the flat cache layout of earlier versions; entries and other top-level paths whose mtime is at or after the sweep's start are left alone. It is not a storage namespace: `/api/list`, full and upstream exports (`listAssetKeys`), and snapshots never see it, and a restore or an import leaves it in place.

Process memory: the module-level `assetVerification` singleton holds bounded verification results and its hash queue, keyed by absolute paths so separate save directories do not collide. The remaining state is inside the `createServerContext` closure:

- `password` and the known key hashes.
- The generation jobs (registry, chat slots, sockets, current-epoch request-id index) and the generation lock. A restart loses both: running jobs end with the process (their receipts then read as ended by `shutdown`), and the message generation fence of their messages closes on the next ordinary write. An ended job stays readable for 60 s (`JOB_DONE_GRACE_MS`); once collected, its kept outcome (`GenerationStatus.kept`, the terminal trimmed: no `result`, `alternatives` over 64 KiB of JSON dropped, an error message cut to 4 KiB, `sequence` kept intact) answers the owner's status for 24 h (`KEPT_OUTCOME_MS`), at most 500 of them (`MAX_KEPT_OUTCOMES`, the oldest dropped first). An epoch change clears them. They are memory's copy: across a restart the owner reads the same outcome from the job's receipt (`data/generation-jobs.sqlite`), for 24 h after the job ended.
- Request identity stays in the live index through the ended-job grace, then moves with its fingerprint to the kept entry; kept expiry/count eviction falls back to disk. Cancellation tombstones have their own 72 h / 10,000-entry memory cap. Epoch changes clear all three views, even with degraded receipts.
- The transform service (`prompt/transform.ts`): its result LRU, pending two-call snapshots and pins, plus `prompt/displayScope.ts`'s `createDisplayScopeLoader` (raw configuration and transcript caches, shared read-only, with a fresh projection per request). Maintenance aborts renders and empties these caches; shutdown aborts renders and clears the loader ([CBS rendering](cbs-rendering.md), [chat pipeline](chat-pipeline.md)).
- Rate-limit counters.
- The resource store's epoch and committed-write counter, the snapshot lock, the maintenance gate, the backup import slot (the version-2 import and the upstream prepare and commit), the import slot the module, CharX, and Realm imports share, the staged Realm imports (`realmStaging`), and the prepared upstream imports (`upstreamStaging`).
- The change feed's listeners and the live-update sockets (nothing is buffered; a restart loses them, and every client reconciles at its reconnect).
- The chat source generations and the `onChatInvalidated` listeners (one entry per chat deleted or replaced whole since the store opened or the last restore; a restart starts them over).
- The thumbnail service (`thumbnails`): its single flights, generation slots and wait queue, per-key locks, and the loaded encoder. A restart loses only work in flight; the disk cache stays.
- The memory task registry (`createMemoryTasks`): per chat the running task, the queued input, the latest retained input, a waiting manual start, and the last terminal status (10 minutes), plus the held summary writer leases. A restart loses them: no task resumes.

## Coupling

- Server dependencies:
  - `hono` and `@hono/node-server`.
  - `ws`, for the upgrade handler.
  - `proxy-addr` and `ipaddr.js`.
  - Node `crypto`/`fs`/`http`/`https`/`net`/`sqlite`.
  - `sharp` 0.34.5, for the asset thumbnails. Its prebuilt `@img/sharp-*` binary loads without the install script, which `pnpm.neverBuiltDependencies` keeps off; a host without one gets the `unavailable` redirect.
  - All of the above are prod dependencies because the Docker runtime stage installs `--prod`.
- Client dependencies that use this server: `serverAuth.ts`, `assetClient.ts`, `resourceClient.ts`, `globalApi` proxy code, `characterCards.hubURL` (`/hub-proxy`), `util.ts` DPoP storage.

## Invariants

- Only paths resolved from the logical storage key and `STORAGE_NAMESPACES` reach
  user storage. Keep the hex wire encoding and its reversible, injective filename
  mapping; do not join a request value directly to a filesystem path.
- A content-addressed asset name is trusted for immutable caching only after its
  bytes are verified. Asset responses open and stat one file handle; thumbnail
  generation uses that same handle. Keep `/api/asset/*` authenticated and preserve
  its security headers, range, conditional-request, and thumbnail behavior.
  Accepted exposure (owner decision, 2026-10-23): a fresh immutable copy has no
  `Vary` on auth, so the browser's HTTP cache answers any same-origin request of
  that URL without reaching the server, including a plugin's `nativeFetch`; the
  service worker passes a request whose destination it does not sign through
  unsigned instead of answering 401 itself. Do not reopen this without a new finding.
- File publication flushes staged file data before rename and syncs its directory
  where supported. Preserve atomic replacement and the ordering of durable writes;
  `EINVAL` and `EPERM` from directory sync are tolerated.
- Preserve route status codes, error bodies, and wire spellings, including the
  `Invaild Path` response. The global JSON body rules are in `http/body.ts`; backup,
  module, CharX, Realm, and self-capping routes have their own size limits.
- Rate limits and client IPs follow the former Express configuration: separate auth,
  login, storage, and authenticated buckets; `TRUST_PROXY` retains Express hop-count
  and `proxy-addr` semantics. IPv4-mapped IPv6 addresses collapse to IPv4, and other
  IPv6 addresses use a `/56` key.
- `http/staticCache.ts` injects `__NODE__` only into the client index served for
  the root and client routes. Static serving must not return an unflagged index. `attachWebSocket` owns one Node
  `upgrade` listener and dispatches only the generation and live-update socket paths.
- Mutations carry the current resource epoch; stale epochs fail without writing.
  Resource revisions, chat groups, restore floors, generation write fences, and
  optimistic recovery are detailed in [persistence](persistence.md). The resource
  store publishes a change only after commit.
- A job writes only while its admitted epoch and live job token remain valid. Message
  ownership is checked in the same synchronous store transaction as the write.
- Restore and import run under maintenance. The store replaces its resource state
  atomically; imports and restore keep an existing content-addressed asset file whose bytes
  verify and replace a damaged one from the staged copy.
- `llmSecrets` is write-only: reads return the masked projection, never credential
  values. Credentials for server provider requests are resolved server-side.
- The server uses one local `save/` directory and one process. Docker persistence
  depends on the `/app/save` volume; removing it loses user data and registered keys.
- Keep the `100 MiB` global request-body limit and route-specific exceptions shown in
  the route table. Do not add decompression or charset-dependent JSON decoding.

## Recipes

- Add a storage operation:
  - Add a route in `routes/storage.ts` with `auth.checkAuth`, the shared limiter, `decodeKeyHeader`, and `resolveStorageKey`.
  - Add the matching client function in `src/ts/storage/assetClient.ts`.
- Add a storage namespace: add it to `STORAGE_NAMESPACES`; the client key prefix is the folder name.
- Change auth:
  - Client: `src/ts/storage/serverAuth.ts` (`createAuth`, `checkAuth`, `digestPassword`).
  - Server: `routes/auth.ts` (`verifyJwt`, the `/api/login` route).
  - Verify first run, restart, token expiry, and unknown keys.
- Change proxy policy: server `sanitizeTargetUrl`, client `localNetwork.ts` + `fetchNative`.
- Change generation jobs: `shared/jobs.ts` (the contract), `server/src/jobs/generationJobs.ts` (the retained events an attach replays: the job chat, the sent records, the `preset`, the running job's `stage`, the current reply, the terminal), `server/src/routes/generations.ts`, the client transport `src/ts/network/generationJobs.ts`, and the client primitives (`applyServerGeneration`, `hydrateChat`, `applyHydration`, `persistence.md`).
- Add a resource kind: add a `ResourceKind` to `DEFAULT_RESOURCE_KINDS` with a pure, idempotent `normalize` (throw `ResourceValidationError` to reject), a `schemaVersion`, `singleton` if it has one record, and `materialize` if the store should create that record (then `normalize(undefined)` must return its default); the routes, snapshots, and archives pick it up. Add the kind name to `RESOURCE_KIND` in `shared/resources.ts` for the client.
- Change the archive format: `server/src/data/archive.ts`, `planImport` and the export in `routes/backups.ts`, `BackupArchiveManifest`, and the client reader in `src/ts/drive/backuplocal.ts`; bump the manifest version.
- Change packaging: `Dockerfile`, the README Docker steps, and `package.json` `server` together. Any new root folder the server imports at runtime (like `shared/`) needs a `COPY` in the `runtime` stage.

## Tests

Server tests live in `server/src/tests/` and select Vitest's Node environment.
`testSupport.ts` provides temporary save directories and in-process
`createTestServer` contexts. Use these files as change anchors; runner, slow-test,
and timing rules belong to [build-test-platforms](build-test-platforms.md).

- Boot, auth, HTTP limits, and shutdown: `app.test.ts`, `listenConfig.test.ts`,
  `shutdown.test.ts`, `shutdownAdmission.test.ts`.
- Resources, chats, checkpoints, and feed: `resourceStore.test.ts`,
  `resources*.test.ts`, `chatStore.test.ts`, `chatCheckpointRoutes.test.ts`,
  `chatCheckpoints.test.ts`, `changeFeed.test.ts`, `events.test.ts`.
- `chatMetadataCoalescingEvents.test.ts` counts transactions on the job fixture’s SQLite connection, so background writes in other stores cannot alter the coalescing assertion.
- `backups.test.ts` waits for an abandoned export’s backup to enter the exclusive queue before aborting; directory visibility alone precedes that admission.
- Snapshots, archives, and imports: `snapshots.test.ts`, `backups.test.ts`,
  `durableWrite.test.ts`, `importModule.test.ts`, `importCharx.test.ts`,
  `importRealm.test.ts`, `upstream*.test.ts`.
- Storage and HTTP: `assets.test.ts`, `assetRoute.test.ts`,
  `assetVerification.test.ts`, `assetThumbnails.test.ts`, `proxy.test.ts`,
  `resourceCompression.test.ts`, `tokenRoutes.test.ts`, `messageSearch.test.ts`.
  `assetRoute.test.ts` "missing asset checks" covers `POST /api/assets/missing`: verified files
  omitted without a rewrite; absent, empty, corrupt, and non-canonical names missing and a repaired
  file present; a sparse file over the read budget missing without a read; auth before the body is
  pulled; the 64 KiB and 512-name limits. `assetVerification.test.ts` "awaited asset verification"
  covers `verifyFiles` with injected hashers and latches: the concurrency bound, budget reservation
  in name order, and no present answer after a concurrent record, forget, or replace.
- Prompt jobs: `assemble.test.ts`, `promptRunner.test.ts`, `promptTail.test.ts`,
  `generationJobs.test.ts`, `generationReceipts.test.ts`, `generationDeltaChunks.test.ts`, `jobChannel.test.ts`.
  `generations.test.ts` covers the chat-slot lookup and stop routes (auth, epoch, `jobChanged`,
  `idle`, no attach or callback authority, first-abort attribution); `commandSequences.test.ts`
  covers another client's stop of a whole sequence with its live, kept, receipt, and diagnostic attribution.
  `generationBarrier.test.ts` covers the callback barrier's job chat over the owner socket: no chat
  frame while unchanged (`hydration=patch`), one patch or a whole copy after a change, whole copies
  for a socket without the flag, and a queued own write carried before the receipt.
  The browser check `util/playwright/checkJobProtocol.mjs` drives request-id replay, a command
  sequence across a reload, the chat-slot stop, owner absence, and a SIGKILL restart against the real
  server ([build-test-platforms](build-test-platforms.md)).
- LLM requests and tokenization: `llmRoutes.test.ts`, `llmRequests.test.ts`,
  `llmProviderAdapters.test.ts`, `llmResponsesApi.test.ts`, `tokens.test.ts`.
- Memory and local models: `memoryTasks.test.ts`, `memoryTaskHost.test.ts`,
  `hypaV3Parts.test.ts`, `hypaV3MemoryWrite.test.ts`, `memoryJobs.test.ts`,
  `embeddings.test.ts`, `vectorCache.test.ts`, `transformers.test.ts`.
- Scripts, Lua, and triggers: `scriptWorker.test.ts`, `luaRuntime.test.ts`,
  `luaBindings.test.ts`, `triggerRuntime.test.ts`, `manualTriggers.test.ts`,
  `commandExecutor.test.ts`, `regexScriptsTask.test.ts`.
- MCP and dynamic assets: `mcp.test.ts`, `mcpInternal.test.ts`, `mcpSse.test.ts`,
  `jobModules.test.ts`, `dynamicAssets.test.ts`.
- CBS, transforms, and translation: `cbs.test.ts`, `cbsLimits.test.ts`,
  `cbsCallDepth.test.ts`, `cbsToggles.test.ts`, `transform.test.ts`,
  `transformService.test.ts`, `translate.test.ts`.
- Diagnostics and request history: `diagnostics.test.ts`,
  `diagnosticsCrash.test.ts`, `requestHistory.test.ts`,
  `requestHistoryRoutes.test.ts`, `requestShare.test.ts`.
  Client transport tests belong to [global API](global-api.md).

## Known Hazards

Runtime limits of other subsystems live with their owners:
[chat-pipeline](chat-pipeline.md), [LLM requests](llm-requests.md),
[memory](memory.md) (the vector cache included), [scripts and triggers](scripts-triggers.md),
[plugins and MCP](plugins-mcp.md), and [CBS/rendering](cbs-rendering.md).

### Issues

- Snapshots (`save/backups/`) copy `resources.sqlite`, not assets; retained
  snapshots can keep references to assets that are never deleted, so
  `save/assets/` can grow.
- Server CBS evaluation runs on the main thread under cooperative limits, with no
  hard deadline or heap bound. Some surrounding prompt work, including Jinja
  rendering, tokenizer calls after model load, and non-worker lore matching, also
  runs there. See [CBS/rendering](cbs-rendering.md) and [chat-pipeline](chat-pipeline.md).
- `/api/remove` deletes sequentially: a filesystem error stops the batch with 500
  and leaves earlier deletions in place.
- `normalizeCharacterOrder` and `normalizeCustomModels` do not deduplicate entries.
  The former accepts folder objects without validating their fields; the latter
  requires string `id` and `internalId` and strips retired credential fields.
- `/api/asset/*` verification is in memory and stat-based; it starts empty after
  restart and cannot detect an outside same-size edit that restores the full stat.
- The thumbnail cache has no byte cap.
- JWT validation does not check issuer, audience, `typ`, or `iat`, and a token
  without `exp` does not expire.
- `/hub-proxy` is unauthenticated and forwards request headers other than
  `risu-auth` to the configured hub.
- Unconfirmed: a provider callback that ends `disconnected` fails its job through
  `endWith` and the runner's finalize (`jobs/runSetup.ts`), not the registry's `abort()`,
  so `JOB_ABORT_GRACE_MS` does not bound that end (the maximum-duration watchdog still
  does). The chat can stay busy longer than owner absence plus abort grace; inspected in
  source, not reproduced.

### Limitations

- An older tab's generation socket without `liveness=1` is never dropped for
  silence. A frozen older tab can therefore hold a provider callback until its own
  deadline (30 minutes) and keep the chat busy. Decision: owner liveness is
  negotiated for compatibility (Generation channels above).
- An older tab's generation socket without `hydration=patch` still gets the job chat
  whole at every callback barrier (`hydrateJobChat`). A no-op hook over 500 messages of
  about 2 KiB stays 500 whole-chat frames of 523,601,000 bytes for that tab
  (`PROBE_HYDRATION=whole` in `job-channel-probe.mjs`). Decision: the barrier's form
  is negotiated for compatibility, since an older tab can only apply a remembered
  whole copy again once its local work settled (Generation channels above).
- A restart does not resume a running generation: its job reads as ended by `shutdown`, the reply's text since its last successful checkpoint (a 3 s target, `CHECKPOINT_INTERVAL_MS` in `prompt/runner.ts`) is lost, and that message's generation fence stays open until the next ordinary write to the message. A degraded receipt store keeps outcomes in memory only, so a restart then forgets them (the tab shows `serverJob.endedAway`). With degraded or absent receipts, request deduplication lasts only through live/kept memory retention and the tombstone cap; it cannot survive a restart; WAL with `synchronous=NORMAL` can also lose the last receipt writes on a power loss.
  Decision: receipts record how a job ended and never refuse or fail a job (`data/generationReceipts.ts` header); resuming a generation across a restart is out of scope.
- The SQLite resource store assumes one server process and a local filesystem.
  Network filesystems are unsupported. Decision: one local `save/` directory and
  one process (Invariants).
- Restore and version-2 import validate and install the database on the serving
  thread, which can block other requests for a large store. Upstream conversion is
  in a worker, but its heap cap does not cover Buffers or SQLite memory.
  Decision: restore and import run under maintenance (Invariants).
- Upstream export holds its records, projected database, and encoded save in memory;
  staged exports are capped at four. An asset of 4 GiB or more cannot fit an archive
  record and is reported as missing. Decision: the staging cap
  (`shared/upstreamExportReport.ts`) and the archive record ceiling
  (`server/src/data/archive.ts`).
- A Lua call stuck in native code cannot reach the abort hook; the worker is
  terminated after its abort grace and queued work waits for a replacement.
  Decision: the pool's watchdog is the bound for a C-level runaway
  (`server/src/lua/runtime.ts` header).
- Directory fsync may be unsupported on a mount (`EINVAL`/`EPERM`); in that case a
  successful rename or link is not guaranteed to survive power loss. This includes
  the auth password and known-key files, which `writeFileDurableSync`
  (`server/src/data/durableWrite.ts`) writes through a flushed temporary file renamed
  into place.
  Decision: `EINVAL` and `EPERM` from directory sync are tolerated (Invariants).
- Replacing bytes under an already cached immutable content name does not update a
  browser's cached asset. The browser may also serve a fresh immutable same-origin
  asset response without reaching server authentication.
  Decision: the owner accepted this exposure on 2026-10-23 (Invariants).
- `/api/set_password` and `/api/crypto` are unauthenticated by design and rate
  limited. A server has one password and registered browser keys, not separate
  users. Decision: the server's auth model (`server/src/routes/auth.ts` header).
- The publication budget bounds a `change` frame's optional payloads only (patches,
  deltas, and summaries); its refs and lock lists are not bounded (an id can be 512
  characters, a character delete records the deletion of every one of its chats, and
  in-process writes have no op cap). A frame whose refs alone cannot be admitted
  terminates the socket, and the client reconnects and reconciles from the revision
  listing (or from its advertised map when the `hello` digest matches). The budget
  also costs the write: every candidate payload is serialized once to be measured,
  rejected ones included, on top of the final frame's serialization. Decision: no
  frame split; one committed write stays one frame, since the client takes a chat's
  lock revision from the same frame's chat ref and reads a lock release without refs
  as `null` (Publication budget in Flows; SD03 in the
  [server migration audit](../research/deep-audit-with-fable/server-migration-audit.md)).
- A chat write pays for its feed entry on the serving thread. A metadata-only write
  that changes the summary (a rename) reads and parses the chat's last row once for
  `lastMessageAt`, a `LIMIT 1` query through `messages_position`, and a group with a
  message op does so before and after the group: all inside the write's transaction,
  so never from the memo. A metadata change parses the stored metadata before and
  after it, once, for the summary comparison and, past `MAX_FEED_PATCH_BYTES`, the
  field form, so an over-cap metadata is parsed where the whole form alone stopped
  at the cap. Decision: every by-id write says what it knows about the summary, since
  one indexed row and one parse cost less than a summary list read by every tab
  (ST04 in the
  [server migration audit](../research/deep-audit-with-fable/server-migration-audit.md)).

### Gotchas

- The job receipt writes are synchronous `node:sqlite` calls on the serving thread, at each admission and each job's end. Measured on 2026-10-28 with `generationReceipts.test.ts` "measures receipt admission, terminal writes, and event-loop delay" (300 jobs with 4–24 KiB kept payloads, `RISU_RECEIPTS_MEASURE_DIR`; WSL2): on local ext4, admission p95 0.05–0.07 ms and terminal p95 0.15–0.16 ms (max about 15 ms, mean event-loop delay about 2 ms, max about 20 ms); on the 9p `/mnt/c` mount as a slow-volume stand-in (an unsupported filesystem here), admission p95 about 4.6 ms and terminal p95 about 8.6 ms, max about 215 ms, event-loop delay p95 about 115 ms and max about 315 ms. A controlled throttle (a cgroup I/O limit) was not available, so a throttled local disk is unmeasured; a slow volume delays every request while a receipt write runs.
- `server/src/lua/runtime.ts` uses wasmoon 1.16's private engine extension table and
  C API, which must be rechecked on a wasmoon upgrade
  ([scripts and triggers](scripts-triggers.md)).
- Backup, module, and CharX uploads share Node's four-hour whole-request timeout.
  Staging under `save/.tmp/` must share a filesystem with asset targets for atomic
  rename. Only one process should use a save directory.
- Resource depth validation runs on parsed JSON after serialization; the HTTP body
  cap bounds uploads, but in-process callers can spend more work before rejection.
  Opening the store normalizes every record, so startup cost grows with the data
  and a refused record stops startup with its kind and id.
- Storage namespace folders are trusted: a symlinked `save/assets` directory is
  followed, although individual file opens reject symlinks where the OS supports it.
- `/api/asset/*` serves one byte range. Thumbnail transforms are versioned by
  `THUMBNAIL_VERSION`; bump it when transform output or input policy changes.
  Animation detection covers multi-page formats reported by `sharp` plus PNG `acTL`.
- Static serving precedes the asset route. A file emitted under `dist/api/asset/`
  would be served before asset authentication and headers; the current build emits
  no `api/` directory.
- `/proxy` and `/proxy2` can reach arbitrary targets; the local-network restriction
  applies to server streaming jobs.
- Reverse proxies must preserve encoded path segments: decoding `%2F` can split a
  resource id containing a slash. Deployment behavior remains unverified.
