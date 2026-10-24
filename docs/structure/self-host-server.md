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
  handle archive and card file transfer.
- Generation and prompt runtime: `jobs/` owns job admission, message locks, and the
  client channel; `prompt/` assembles and runs prompts, transformations, triggers,
  memory, and tokenization; `lua/` and `scripts/` provide the worker-backed script
  runtime. Contracts shared with the tab are covered by
  [chat-pipeline](chat-pipeline.md), [LLM requests](llm-requests.md),
  [memory](memory.md), [scripts and triggers](scripts-triggers.md), and
  [plugins and MCP](plugins-mcp.md).
- Other server services: `llm/` adapts providers and credentials;
  `translation/runner.ts` stores server-side translations ([media and auxiliary work](media-aux.md));
  `push/pushService.ts` handles Web Push; `data/vectorCache.ts` stores embeddings;
  `diagnostics/` owns request history, diagnostic journals, reports, and support
  shares ([diagnostics](diagnostics.md)).
- HTTP helpers: `http/{body,rateLimit,clientIp,compressedJson,staticCache,assetVerification,assetThumbnails}.ts`
  cover request limits, client IPs, caching, and asset delivery. `routes/limitedBody.ts` owns global and route-specific streaming body caps. Thumbnail cache
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
2. `bodyLimit` (100 MiB, 413 `{error:"Request body too large"}`), skipped for `POST /api/backups/import`, `POST /api/backups/import-upstream/prepare`, `POST /api/import/module`, and `POST /api/import/charx`, which stream their bodies to disk under their own cap, and for `POST /api/import/realm` and its `/commit` and `/cancel`, which cap their `{ id }` or `{ token }` body at 4 KiB, and for `POST /api/chat-checkpoints/*` and `PUT /api/chat-checkpoints/policy`, which cap their bodies at 16 KiB after authentication, and for `POST /api/chats/search`, which caps its body at 4 KiB of received bytes, and for `POST /api/tokens/count` and `/api/tokens/encode`, which cap theirs at 2 MiB after authentication. The global cap and routes that cap their own bodies with `bodyLimit` use the shared helper in `server/src/routes/limitedBody.ts`: a body over the cap answers 413, and a request stream that fails while the limiter reads it answers 400, never the app's 500.
3. `GET /` and `GET /index.html` (one shared handler, with `no-cache`, a weak size/mtime ETag, `Last-Modified`, and conditional 304 responses), then the same handler for the client's screen routes: a `GET *` handler serves it when `isClientRoutePath` (`shared/routes.ts`: first segment `chat`, `playground`, `realm`, `characters`, or `settings`) matches and passes every other path on ([URL routes](app-shell.md)).
4. `createStaticCache` (`server/src/http/staticCache.ts`) checks regular files before `serveStatic` handles every other GET/HEAD: `/assets/*` gets `public, max-age=31536000, immutable`; all other files (including `sw.js` and `manifest.json`) get `no-cache`. Both carry a weak size/mtime ETag and `Last-Modified`. Matching `If-None-Match` (weak comparison; `*` only as the whole field) answers a bodyless 304; only when that header is absent, a parseable `If-Modified-Since` at or after mtime floored to whole seconds also answers 304. Otherwise, `If-Range` permits Range only with a matching strong ETag or the exact `Last-Modified` date; weak tags, stale validators, and invalid values discard Range and serve the full 200. Missing or rejected paths pass on without cache headers.
5. The routes below.

Routing is non-strict (a trailing slash matches).

| Method     | Path                                                   | Auth                                                                         | Rate limit                                                                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET/HEAD   | `dist/*`                                               | none                                                                         | none                                                                                                           | built frontend (`serveStatic`: bytes and ranges; `createStaticCache`: weak size/mtime ETag, `Last-Modified`, conditional 304; `/assets/*`: `public, max-age=31536000, immutable`; other files: `no-cache`)                                                                                                                                                                                                                      |
| GET        | `/`, `/index.html`                                     | none                                                                         | none                                                                                                           | serves `dist/index.html` with `globalThis.__NODE__ = true` injected after the `<head>` tag; `no-cache`, weak size/mtime ETag, `Last-Modified`, conditional 304 (also on screen routes); the same open handle supplies stat and text, and a missing `<head>` still throws before a conditional answer                                                                                                                            |
| GET/POST   | `/proxy`, `/proxy2`                                    | `checkProxyAuth` (stored password in `risu-auth`, or a registered ES256 JWT) | 2000/min                                                                                                       | arbitrary reverse proxy (`risu-url`, `risu-header`); with `risu-aux-op`, JWT only and one auxiliary operation (`server/src/llm/auxOps.ts`, below)                                                                                                                                                                                                                                                                               |
| GET        | `/hub-proxy/*`                                         | none                                                                         | 2000/min                                                                                                       | proxies to `https://sv.risuai.xyz` only (path and query after `/hub-proxy`); one redirect within that origin is followed, any other redirect is answered to the browser                                                                                                                                                                                                                                                         |
| GET        | `/api/chat-checkpoints?characterId=&chatId=`           | JWT                                                                          | 2000/min shared                                                                                                | `{ epoch, checkpoints }`, newest first; 400/404; `no-store`                                                                                                                                                                                                                                                                                                                                                                     |
| GET        | `/api/chat-checkpoints/policy?characterId=&chatId=`    | JWT                                                                          | 2000/min shared                                                                                                | 200 `{ epoch, policy: { autoEvery, autoKeep } \| null }`; 400/404; `no-store`                                                                                                                                                                                                                                                                                                                                                   |
| PUT        | `/api/chat-checkpoints/policy`                         | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, autoEvery, autoKeep }` or `{ characterId, chatId, off: true }` → 200 `{ epoch, policy: { autoEvery, autoKeep } \| null }`; 400/404/412/413/503; `no-store`                                                                                                                                                                                                                                              |
| POST       | `/api/chat-checkpoints/save`                           | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, name }` → `{ epoch, checkpoint }`; captures server state; 400/404/409 `generating`/412/413/503; `no-store`                                                                                                                                                                                                                                                                                              |
| POST       | `/api/chat-checkpoints/rename`                         | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, id, baseRevision, name }` → `{ epoch, checkpoint }`; 400/404/409 with current `revision`/412/413/503; `no-store`                                                                                                                                                                                                                                                                                        |
| POST       | `/api/chat-checkpoints/delete`                         | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, id, baseRevision }` → `{ epoch, ok: true }`; 400/404/409 with current `revision`/412/413/503; `no-store`                                                                                                                                                                                                                                                                                                |
| POST       | `/api/chat-checkpoints/load`                           | JWT + epoch                                                                  | 2000/min shared                                                                                                | `{ characterId, chatId, id, chatBaseRevision }` → `{ epoch, chatRevision, safety }`; atomic replacement with safety summary; 400/404/409 (current `revision` or `reason: "generating"`)/412/413/503; `no-store`                                                                                                                                                                                                                 |
| POST       | `/api/generations`                                     | JWT                                                                          | 2000/min                                                                                                       | creates a generation job (`GenerationCreateBody`, `x-resource-epoch`): `{ jobId }`; 409 `chatBusy { jobId }`, `stale`, `chatBindingIncomplete { problems }`, or `chatBindingMismatch`, 404, 412, 503                                                                                                                                                                                                                            |
| GET        | `/api/generations/:id?clientId=`                       | JWT                                                                          | 2000/min                                                                                                       | the owner's `GenerationStatus` (404 for another client's job)                                                                                                                                                                                                                                                                                                                                                                   |
| DELETE     | `/api/generations/:id?clientId=`                       | JWT                                                                          | 2000/min                                                                                                       | aborts the owner's job: `{ aborted }`                                                                                                                                                                                                                                                                                                                                                                                           |
| POST       | `/api/generations/:id/memory-stop?clientId=`           | JWT + epoch                                                                  | 2000/min                                                                                                       | stops the owner's job's initial memory summarization run (`{ runId }`) after its summary in progress, the job going on: `{ stopped: true }`; 400, 404, 409 `jobEnded`, `noMemoryRun`, or `otherMemoryRun`, 412                                                                                                                                                                                                                  |
| POST       | `/api/generations/:id/drained?clientId=`               | JWT                                                                          | 2000/min                                                                                                       | the owner reports a callback of its job the server cancelled as no longer running in the tab (`ChannelDrainedBody` `{ callbackId }`), freeing the client's channel lane: `{ drained }` (false when it held none; also for an ended job still kept); 400, 404                                                                                                                                                                    |
| POST       | `/api/transform`                                       | JWT + epoch                                                                  | 2000/min                                                                                                       | the script transform (`TransformRequest`, `shared/transform.ts`): `{ results }`, or with `handlers` `{ results, snapshotId, pending }`; 400, 404, 409 `chatBindingMismatch`, 412, 413, 503 `Retry-After: 5`                                                                                                                                                                                                                     |
| POST       | `/api/translate/message`                               | JWT + epoch                                                                  | 2000/min                                                                                                       | translates one stored message on the server: `{ outcome, translation }` (`applied`, `ignored`, `fresh`); 400, 404, 409 `generating`/`chatBindingMismatch`, 412, 413, 429, 502, 503 `Retry-After: 5`, 504                                                                                                                                                                                                                        |
| POST       | `/api/memory/tasks`                                    | JWT + epoch                                                                  | 2000/min                                                                                                       | a manual memory task start (`{ characterId, chatId }`, 4 KiB): `{ outcome: "running" \| "queued", status }` or `{ outcome: "pendingManual" }`; 400, 404, 412, 413, 429 `queueFull`, 503 `notEnabled` (the runner's service disabled or replaced, tests), 503 `Retry-After: 5` (shutdown, maintenance); `no-store`                                                                                                               |
| DELETE     | `/api/memory/tasks/:characterId/:chatId`               | JWT + epoch                                                                  | 2000/min                                                                                                       | cancels the chat's memory task: `{ cancelled }`; 400, 404, 412, 503 `notEnabled`; `no-store`                                                                                                                                                                                                                                                                                                                                    |
| POST       | `/api/transform/continue`                              | JWT + epoch                                                                  | 2000/min                                                                                                       | the second call after the tab's plugin handlers (`TransformContinueRequest`): `{ results }`; 400, 409 `SnapshotExpired`, 412, 503                                                                                                                                                                                                                                                                                               |
| WS upgrade | `/api/generations/:id/ws?clientId=&attach=`            | JWT in the `risu-auth` query or header (never the password)                  | none                                                                                                           | the owner's `GenerationEvent` stream                                                                                                                                                                                                                                                                                                                                                                                            |
| POST       | `/api/llm/request`                                     | JWT + epoch                                                                  | 2000/min                                                                                                       | one provider request on the server (`LlmRequestBody`, `shared/llm/request.ts`); an SSE stream of `LlmRequestEvent`s; 400, 409 (`channelCall` not running; with `args.chatRef`, `chatBindingIncomplete { problems }` or `chatBindingMismatch`), 412, 429 (32 per client), 503                                                                                                                                                    |
| POST       | `/api/llm/request/:id/answer`                          | JWT                                                                          | 2000/min                                                                                                       | answers one of the request's callbacks (`{ clientId, callbackId, outcome, value \| error }`): `{ accepted }` or `{ ignored }`; 404 for another client's or an ended request                                                                                                                                                                                                                                                     |
| POST       | `/api/tokens/count`                                    | JWT                                                                          | 2000/min                                                                                                       | `{ scope: TabTokenScope, texts }` (2 MiB, 512 texts): `{ counts }`, null only for a refused text; 400, 413, 429, 500, 503 `Retry-After: 5` (maintenance, shutdown); `no-store`                                                                                                                                                                                                                                                  |
| POST       | `/api/tokens/encode`                                   | JWT                                                                          | 2000/min                                                                                                       | `{ tokenizer, text }` (2 MiB): `{ ids }`, the tab's playground family; 400 (bad body or refused text), 413, 429, 500, 503 `Retry-After: 5` (maintenance, shutdown); `no-store`                                                                                                                                                                                                                                                  |
| PUT        | `/api/llm-secrets/<path>`                              | JWT + epoch                                                                  | 2000/min                                                                                                       | body `{ value, baseRevision }`; sets one credential (`routes/llmSecrets.ts`); `{ epoch, revision, data }` with the masked record; 400, 409 `{ error, revision }`, 412, 503                                                                                                                                                                                                                                                      |
| DELETE     | `/api/llm-secrets/<path>?baseRevision=`                | JWT + epoch                                                                  | 2000/min                                                                                                       | clears one credential; answers as the PUT                                                                                                                                                                                                                                                                                                                                                                                       |
| GET        | `/api/push/key`                                        | JWT                                                                          | 2000/min                                                                                                       | `{ publicKey }`: the VAPID public key, null while push is off on the server                                                                                                                                                                                                                                                                                                                                                     |
| PUT        | `/api/push/subscription`                               | JWT                                                                          | 2000/min                                                                                                       | body `{ subscription }` (`PushSubscription.toJSON()`, 16 KiB cap): 204; 400 for an invalid one or an endpoint outside the allowed push services; 503 while push is off; 500 when the file could not be written                                                                                                                                                                                                                  |
| DELETE     | `/api/push/subscription`                               | JWT                                                                          | 2000/min                                                                                                       | body `{ endpoint }`: 204, also when it was not registered; 500 when the file could not be written                                                                                                                                                                                                                                                                                                                               |
| GET        | `/api/request-history?cursor&limit&…`                  | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| GET        | `/api/request-history/:id`                             | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| DELETE     | `/api/request-history`                                 | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| PUT        | `/api/request-history/share`                           | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| GET        | `/api/request-history/shares`                          | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| GET        | `/api/diagnostics`                                     | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| POST       | `/api/diagnostics/report`                              | JWT                                                                          | 2000/min [History, reports, and support-share contract](diagnostics.md#files); JWT, shared limiter, `no-store` |
| GET        | `/api/test_auth`                                       | none                                                                         | 2000/min (own)                                                                                                 | returns `unset`, `incorrect`, or `success`                                                                                                                                                                                                                                                                                                                                                                                      |
| POST       | `/api/login`                                           | password digest                                                              | 10 per 30 s                                                                                                    | registers a public-key hash                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST       | `/api/crypto`                                          | **none**                                                                     | 2000/min (auth bucket)                                                                                         | SHA-256 of `body.data` (text/plain)                                                                                                                                                                                                                                                                                                                                                                                             |
| POST       | `/api/set_password`                                    | **none**, only works while unset                                             | 10 per 30 s (shared with `/api/login`)                                                                         | first-run password setup                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET        | `/api/read`, `/api/remove`, `/api/list`                | `checkAuth` (JWT)                                                            | 2000/min (storage)                                                                                             | storage. The `file-path` header is the hex UTF-8 key; `remove` takes `$$`-joined hex keys.                                                                                                                                                                                                                                                                                                                                      |
| GET/HEAD   | `/api/asset/*`                                         | `checkAuth` (JWT)                                                            | 2000/min (storage)                                                                                             | stored asset bytes; the path suffix is the hex UTF-8 key; extension-based MIME, single byte range (206/416), conditional ETag (304), and no body for HEAD; 401 for a missing or rejected JWT, 404 for a missing or unsupported key. `?w=256` or `?w=512` selects a WebP thumbnail of the same asset, or a 307 to the original; any other `w`, an empty one, or a repeated one is 400                                            |
| POST       | `/api/write`                                           | `checkAuth`                                                                  | 2000/min (storage)                                                                                             | storage write, raw body bytes                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST       | `/api/assets/write`                                    | `checkAuth`                                                                  | 2000/min (storage)                                                                                             | batch storage write (`shared/assetBatch.ts`): raw body of archive-framed records named by logical key, each staged, then renamed into place under the gate (overwrites); `{ success: true, written }`; 400 `Invaild Path` + `index` or `Invalid asset batch`, 503, 500, each after the body is read                                                                                                                             |
| POST       | `/api/assets/read`                                     | `checkAuth`                                                                  | 2000/min (storage)                                                                                             | batch storage read: body `{ keys }` (1-2000 keys); a chunked `no-store` octet stream of one record per key, in order, duplicates kept (zero-length for a missing file, a symlink, a non-regular file, or a key with no storage location); 400                                                                                                                                                                                   |
| GET        | `/api/resources?kinds=a,b[&chats=1\|&chatSummaries=1]` | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ epoch, kinds: { <kind>: [{ id, revision, data }] }, chats?, chatSummaries?, chatOrders? }`, one committed state, compressed per `Accept-Encoding` (`compressedJson`); 400 for an unknown or missing kind, or for both chat options                                                                                                                                                                                           |
| POST       | `/api/resources/read`                                  | `checkAuth`                                                                  | 2000/min                                                                                                       | body `{ refs?, chats?: [{ characterId, id }], chatCollections?: [characterId], chatSummaryCollections?: [characterId] }` (1-5000 in all); `{ epoch, items, chats?, chatCollections?, chatSummaryCollections? }` (null for a missing record or chat; summaries: no messages, memory, bookmarks, or `toolCalls`)                                                                                                                  |
| POST       | `/api/resources/boot`                                  | `checkAuth`                                                                  | 2000/min                                                                                                       | body `ResourceBootRequest` `{ kinds, chatSummaries?: true, known?: { records?: [{ kind, id, revision }], items?: [{ kind, hashes }] } }` (own 2 MiB cap, 413 past it; 400 for a malformed entry, an unknown requested kind, or more than 5000 entries); `ResourceBootResult` `{ format: 1, epoch, kinds, chatSummaries?, chatOrders? }` with `cached` and `items` records (`resourceBoot.ts`), compressed per `Accept-Encoding` |
| POST       | `/api/chats/search`                                    | `checkAuth`                                                                  | 2000/min                                                                                                       | body `MessageSearchQuery` (`shared/messageSearch.ts`, 4 KiB); `MessageSearchPage`, `no-store`; 404 named character/chat missing, 409 `reason: "epoch"`, 429 past two running, 503 maintenance (see Files)                                                                                                                                                                                                                       |
| POST       | `/api/resources/batch`                                 | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | body `{ ops?, chats?, chatOrders? }` (1-5000 operations, nested chat ops counted, see Invariants; a resource op has exactly one of `data`, `delete`, and `patch`); `{ epoch, results, chats?, chatOrders? }`; 409 `{ error, conflicts }` with nothing applied                                                                                                                                                                   |
| GET        | `/api/resources/revisions`                             | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ epoch, resources: [{ kind, id, revision }], chats: [{ characterId, id, revision }], chatOrders: [{ characterId, revision }] }`, no data (the live-update reconcile)                                                                                                                                                                                                                                                          |
| WS upgrade | `/api/events/ws`                                       | JWT in the `risu-auth` query or header (never the password)                  | none                                                                                                           | the live-update stream: `hello`, `change`, `epoch`, `ping` (`shared/events.ts`)                                                                                                                                                                                                                                                                                                                                                 |
| GET        | `/api/resources/:kind`                                 | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ epoch, items: [{ id, revision, data }] }` in creation order; 404 for an unknown kind                                                                                                                                                                                                                                                                                                                                         |
| GET        | `/api/resources/:kind/:id`                             | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ epoch, revision, data }`; 404 when missing, 400 for an invalid id                                                                                                                                                                                                                                                                                                                                                            |
| PUT        | `/api/resources/:kind/:id`                             | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | body `{ baseRevision: string \| null, data }`; `{ epoch, revision, data }` as stored; 409 `{ error, revision }` on a stale revision                                                                                                                                                                                                                                                                                             |
| DELETE     | `/api/resources/:kind/:id`                             | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | `?baseRevision=<token>`; `{ success: true, epoch }`; 409 `{ error, revision }` when stale or already gone; 400 for a singleton                                                                                                                                                                                                                                                                                                  |
| GET        | `/api/backups`                                         | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ items: [{ id, createdAt, size }] }`, newest first                                                                                                                                                                                                                                                                                                                                                                            |
| POST       | `/api/backups/:id/restore`                             | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | replaces every resource with the snapshot (safety snapshot first); `{ epoch }`; 404 unknown id, 400 invalid snapshot                                                                                                                                                                                                                                                                                                            |
| POST       | `/api/backups/export`                                  | `checkAuth`                                                                  | 2000/min                                                                                                       | body `{ partial?: true \| string[] }` (`true`: profile assets selected from the archived snapshot; list: explicit asset keys); streams an archive (see Flows); 400 for invalid input or too many partial assets, 413 when it cannot fit the format                                                                                                                                                                              |
| POST       | `/api/backups/import`                                  | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | raw archive body (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`, default 16 GiB); `{ epoch, assetsWritten, assetsSkipped }`; 400/413                                                                                                                                                                                                                                                                                                |
| POST       | `/api/backups/import-upstream/prepare`                 | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | raw upstream RisuAI `.bin` body (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`): converted in a worker into a staged store, nothing replaced; NDJSON (`shared/upstreamBackup.ts`): `{ phase, done, total }` lines, then `{ token, report }`, or `{ error }`; 400 (a refused archive, a Risu Account backup's message among them), 409 (busy, or `Another RisuAI backup import is waiting for its answer`), 412, 413, 503            |
| POST       | `/api/backups/import-upstream/commit`                  | `checkAuth` + epoch                                                          | 2000/min                                                                                                       | `{ token, acceptWrites? }`: replaces every resource with the staged store (safety snapshot first); `{ epoch, assetsWritten, assetsSkipped, selection }`; 404 `Import expired`, 409 busy or `{ error: "changedSinceReview", writes }`, 412, 400 (invalid body or staged store), 503 (the import kept on 409/412/503)                                                                                                             |
| POST       | `/api/backups/import-upstream/cancel`                  | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ token }`: removes the prepared import; 204 whether it still waited or not; 400                                                                                                                                                                                                                                                                                                                                               |
| POST       | `/api/backups/export-upstream/prepare`                 | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ promptPresetId, modelPresetId, personaId, includeSecrets, selectedChat? }`: projects one copy of the store into a RisuAI `database.risudat` in a worker and keeps it under a token; `{ token, report }` (`shared/upstreamExportReport.ts`); 400 invalid body, 409 `Other RisuAI-compatible backups are waiting for their download`, 413 when it cannot fit the archive format, 503 during shutdown                           |
| GET        | `/api/backups/export-upstream/download`                | `checkAuth`                                                                  | 2000/min                                                                                                       | `?token=`: uses the token up and streams the referenced assets as basename records, then `database.risudat` (see Flows); 400 malformed token, 404 `Export expired`                                                                                                                                                                                                                                                              |
| POST       | `/api/backups/export-upstream/cancel`                  | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ token }`: removes the prepared export; 204 whether it still waited or not; 400                                                                                                                                                                                                                                                                                                                                               |
| POST       | `/api/import/module`                                   | `checkAuth`                                                                  | 2000/min                                                                                                       | raw `.risum` body (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`); NDJSON (`shared/moduleImport.ts`): `{ done, total }` lines, then `{ module, assetsWritten, assetsSkipped }` with each stored key in `module.assets[i][1]`, or `{ error }`; 400/409/413, 503 `Retry-After: 5`                                                                                                                                                     |
| POST       | `/api/import/charx`                                    | `checkAuth`                                                                  | 2000/min                                                                                                       | raw CharX body, a zip or a `charxJpeg` (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`); NDJSON (`shared/charxImport.ts`): `{ done, total }` lines, then `{ card, moduleData, assets, excluded }` (`moduleData` base64, `assets` entry name → stored key), or `{ error }`; 400/409/413, 503 `Retry-After: 5`                                                                                                                         |
| POST       | `/api/import/realm`                                    | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ id }` (4 KiB cap): the server downloads, validates, and stages the Realm card, writing nothing; NDJSON (`shared/realmImport.ts`): one `{ kind: "charx" \| "png", token, card, ... }` or `{ kind: "json", body }` line, or `{ error }`; 400/409 (busy, or `Too many imports are waiting`)/413, 502 (Realm's text or `Realm download failed`), 503                                                                             |
| POST       | `/api/import/realm/commit`                             | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ token }` (4 KiB cap): stores the staged card's assets; NDJSON: `{ done, total }` lines, then `{ kind: "charx", assets, excluded }` or `{ kind: "png", image, assets }`, or `{ error }`; 400, 404 `Import expired`, 409, 413, 503 (the staged import kept on 409/503)                                                                                                                                                         |
| POST       | `/api/import/realm/cancel`                             | `checkAuth`                                                                  | 2000/min                                                                                                       | `{ token }` (4 KiB cap): removes the staged card; 204 whether it still waited or not; 400, 413, 503                                                                                                                                                                                                                                                                                                                             |

"+ epoch" means the `x-resource-epoch` header must name the current database epoch (412 `{ error: "EpochMismatch", epoch }` otherwise). Mutations answer 503 with `Retry-After` while a restore or an import runs. During shutdown, new resource requests (including reads), backup requests, and module and CharX imports also answer 503 with `Retry-After`; a typed store-closed error maps to the same retryable response. Every `/api/resources` and `/api/llm-secrets` response is `Cache-Control: no-store`. Every read route (`/api/resources?kinds=`, `/api/resources/read`, `/api/resources/:kind`, `/api/resources/:kind/:id`) and the PUT response answer a kind with `project` in its projected form: `llmSecrets` is masked.

The resource, proxy, and job rows marked "2000/min" share one limiter; `test_auth` has its own. Login has its own. The storage rows marked "2000/min (storage)" have their own bucket with the same threshold, so an asset burst (a module import or export) cannot starve resource sync.

`/api/asset/*` answers with `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Accept-Ranges: bytes`, and `Content-Disposition: inline`, including errors and 304s. Byte responses and 304s use the extension's MIME from `shared/assetMime.ts`, including `flac` as `audio/flac` and `mkv` as `video/x-matroska` (unknown types: `application/octet-stream`); `html`, `htm`, `xhtml`, `xml`, `js`, and `mjs` use `attachment` and `application/octet-stream`, while SVG stays inline under the CSP sandbox. Successful responses and 304s are `Cache-Control: private, no-cache` with a weak ETag unless the content name is verified against the stat of the handle supplying the bytes. Verified names use `Cache-Control: private, max-age=31536000, immutable` and the strong ETag `"sha256-<hex>"` on 200/206 responses. A verified name accepts either its strong tag or its current weak stat tag in `If-None-Match`; a 304 carries the tag that matched and the immutable Cache-Control, so revalidating an earlier weak-tagged copy upgrades its caching policy. Comparison is weak for both tag forms, lists, whitespace, and a lone `*`; a strong-tag match takes precedence when both tags match. The weak ETag uses size, nanosecond mtime, and inode; a matching `If-None-Match` takes precedence over Range. Errors remain `no-store`. A single satisfiable `bytes=` range gets 206 with `Content-Range` and its length; an unsatisfiable range gets 416 with `Content-Range: bytes */<size>`. HEAD ignores Range and returns the full length (or 304); empty files ignore Range and return an empty 200.

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
caps: oversized bodies answer 413, and stream failures while prereading answer 400
`{ error: "Invalid JSON body" }` (or the route's configured read error). A JSON body
read failure in `http/body.ts`, including one after a declared Content-Length skips
the limiter's preread, uses the same 400 answer as invalid JSON.

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
- `server/web_push_vapid.json` (mode 600): the Web Push VAPID pair. Replacing it (or the `RISU_WEB_PUSH_VAPID_*` variables) leaves every browser subscribed with the old key: each subscribes again the next time it opens the app.
- `server/push_subscriptions.json` (mode 600): `{ version: 1, subscriptions: [{ endpoint, keys: { p256dh, auth }, expirationTime, failureCount, lastError?, updatedAt }] }`.
- `.tmp/`: staged writes and the per-operation export/import staging folders, emptied at startup.
- `data/resources.sqlite` (plus its `-wal` and `-shm` files): the resource store. Table `resources` (`seq` autoincrement, `kind`, `id`, `revision`, `schemaVersion`, `data` JSON text, unique `(kind, id)`), table `meta` holding the random `epoch`, table `chats` (`seq`, `characterId`, `id`, `revision`, `schemaVersion`, `meta` JSON), table `messages` (`chatSeq`, message `id`, integer `position`, `data` JSON, and the generation fence: `generationId`, `generationSeq`, `generationFinal`, `generationHistory` of up to 8 earlier ids), table `chatOrders` (`characterId`, `seq`, `revision`, `ids` JSON), and table `chatGroups` (`seq` autoincrement, `chatSeq` referencing `chats.seq` with `ON DELETE CASCADE`, `groupId`, `revision`, `result` JSON, unique `(chatSeq, groupId)`), which `createChatTables` creates when missing, so a version-3 file from before it gains it on open without a version change; it is not part of the snapshot layout check, a snapshot's copy of it is not restored, and a restore leaves it empty (deleting the chats cascades). The checkpoint tables are created the same way and are outside the required layout (a snapshot without them is valid), but a snapshot that has any of them is checked and restored with them (`readCheckpointSnapshotRows`): `chatCheckpoints` (`seq` autoincrement, `chatSeq` referencing `chats.seq` with `ON DELETE CASCADE`, `id`, `kind` (`manual`, `auto`, `safety`), `name`, `createdAt`, `revision`, `chatRevision`, `userTurns`, `messageCount`, `preview` JSON, `pages` JSON (the ordered message page hashes), `fields` JSON (captured field → page hash), unique `(chatSeq, id)`), `checkpointPages` (`hash` primary key, `text`), `checkpointPageRefs` (`checkpointSeq` referencing `chatCheckpoints.seq` with `ON DELETE CASCADE`, `hash`, indexed), and `chatCheckpointPolicy` (`chatSeq` primary key referencing `chats.seq` with `ON DELETE CASCADE`, `autoEvery`, `autoKeep`, `lastAutoTurns`); a page no ref names is swept at open and in every checkpoint delete and prune, and a restore keeps only the snapshot's referenced pages, so a deleted chat's pages wait for the next sweep; `PRAGMA user_version` is the store version (3: settings sections and collections, no `root` record; the tables are those of version 2). Opening the store and every `replaceAll` run the normalization pass in one transaction: each record whose normalized text or schema version differs from the stored one is rewritten with its revision counter advanced (same `seq` and epoch), and each missing `materialize` singleton is created; a stored record its normalizer rejects, or one of a newer schema version than its kind, stops the start. A version-1 file or version-2 file (settings in a `root` record) is refused at startup with a message naming it, and a snapshot or archive of another version is refused on restore; there is no migration (formats of metatron's implementation phases, `persistence.md` compatibility rule). The connection runs with `journal_mode=WAL`, `busy_timeout=5000`, and `foreign_keys=ON`. `data/` is not a storage namespace.
- `backups/`: resource snapshots (`resources-*.sqlite`, single files, newest 20), not a storage namespace. Assets are not in snapshots.
- User files: a logical key `assets/<name>` lives at `save/assets/<encodeFileName(name)>`, e.g. `assets/<sha>.png` or `assets/inlay_<sha256>.png`. The legacy `save/database` and `save/remotes` folders are left in place and no longer read.
  - `encodeFileName` keeps `a-z 0-9 . _ -` readable and writes every other UTF-8 byte (uppercase letters, `/`, `%`, spaces, non-ASCII) as `%XX`. It also escapes a trailing dot and the first character of a Windows device name (`con.png` → `%63on.png`). A name whose readable form exceeds 255 bytes is stored as `~<lowercase hex>`; longer than that is rejected.
  - Only one encoding per name is canonical, and canonical names never differ by case alone, so case-insensitive filesystems do not merge keys.
  - The old flat layout (hex file names and `__password` directly in `save/`) is not read and was not migrated.
- `cache/thumbnails/<sha256(key)>/<entry name>`: the asset route's derived WebP thumbnails, with each key directory created when an entry is ready to be staged. Each entry is `<sha256(key)>-w<size>-v<THUMBNAIL_VERSION>-<size>-<mtimeNs>-<ino>-<dev>` plus `.webp`, or `.orig` (an empty marker for a deterministic "serve the original" decision: small, animated, non-raster or unsupported, or over the input caps; never for a transient failure). Entries are staged under `.tmp/` and renamed into place, outside the maintenance gate. Publication and removal touch only that key's directory: after publishing, the service lists it and drops entries whose identity differs from the source file's current stat (all of them when the source is gone, including the one just written), removing the directory if empty; `/api/remove` removes the directory. A sweep after listen (`startBackgroundTasks`, aborted at shutdown) walks key directories and drops non-regular entries, entries of a missing or changed source, entries of another `THUMBNAIL_VERSION`, and entries with an unknown name or a hash that differs from their directory, then removes empty directories. It removes anything else at the top level, including the flat cache layout of earlier versions; entries and other top-level paths whose mtime is at or after the sweep's start are left alone. It is not a storage namespace: `/api/list`, full and upstream exports (`listAssetKeys`), and snapshots never see it, and a restore or an import leaves it in place.

Process memory: the module-level `assetVerification` singleton holds bounded verification results and its hash queue, keyed by absolute paths so separate save directories do not collide. The remaining state is inside the `createServerContext` closure:

- `password` and the known key hashes.
- The generation jobs (registry, chat slots, sockets) and the generation lock. A restart loses both: running jobs end with the process, and the message generation fence of their messages closes on the next ordinary write.
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
  atomically; imports preserve existing content-addressed asset files.
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
- Prompt jobs: `assemble.test.ts`, `promptRunner.test.ts`, `promptTail.test.ts`,
  `generationJobs.test.ts`, `generationDeltaChunks.test.ts`, `jobChannel.test.ts`.
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

- The SQLite resource store assumes one server process and a local filesystem.
  Network filesystems are unsupported. Snapshots cover `save/data/`, not assets;
  retained snapshots can keep references to assets that are never deleted, so
  `save/assets/` can grow.
- Restore and version-2 import validate and install the database on the serving
  thread, which can block other requests for a large store. Upstream conversion is
  in a worker, but its heap cap does not cover Buffers or SQLite memory.
- Upstream export holds its records, projected database, and encoded save in memory;
  staged exports are capped at four. An asset over 4 GiB cannot fit an archive
  record and is reported as missing.
- Server CBS evaluation runs on the main thread under cooperative limits, with no
  hard deadline or heap bound. Some surrounding prompt work, including Jinja
  rendering, tokenizer calls after model load, and non-worker lore matching, also
  runs there. See [CBS/rendering](cbs-rendering.md) and [chat-pipeline](chat-pipeline.md).
- A Lua call stuck in native code cannot reach the abort hook; the worker is
  terminated after its abort grace and queued work waits for a replacement.
  `server/src/lua/runtime.ts` also uses wasmoon 1.16's private engine extension table and C API,
  which must be rechecked on a wasmoon upgrade ([scripts and triggers](scripts-triggers.md)).
- `server/src/data/vectorCache.ts` bounds stored vector bytes, not the SQLite file size; eviction
  trimming runs on the main thread ([memory](memory.md)).
- Backup, module, and CharX uploads share Node's four-hour whole-request timeout.
  Staging under `save/.tmp/` must share a filesystem with asset targets for atomic
  rename. Only one process should use a save directory.
- `/api/remove` deletes sequentially: a filesystem error stops the batch with 500
  and leaves earlier deletions in place.
- Resource depth validation runs on parsed JSON after serialization; the HTTP body
  cap bounds uploads, but in-process callers can spend more work before rejection.
  Opening the store normalizes every record, so startup cost grows with the data
  and a refused record stops startup with its kind and id.
- `normalizeCharacterOrder` and `normalizeCustomModels` do not deduplicate entries.
  The former accepts folder objects without validating their fields; the latter
  requires string `id` and `internalId` and strips retired credential fields.
- Directory fsync may be unsupported on a mount (`EINVAL`/`EPERM`); in that case a
  successful rename or link is not guaranteed to survive power loss. Auth password
  and known-key files are written directly rather than through atomic staging.
- Storage namespace folders are trusted: a symlinked `save/assets` directory is
  followed, although individual file opens reject symlinks where the OS supports it.
  `/api/asset/*` verification is in memory and stat-based; it starts empty after
  restart and cannot detect an outside same-size edit that restores the full stat.
- Replacing bytes under an already cached immutable content name does not update a
  browser's cached asset. The browser may also serve a fresh immutable same-origin
  asset response without reaching server authentication.
- `/api/asset/*` serves one byte range. Thumbnail transforms are versioned by
  `THUMBNAIL_VERSION`; bump it when transform output or input policy changes. The
  thumbnail cache has no byte cap, and animation detection covers multi-page formats
  reported by `sharp` plus PNG `acTL`.
- Static serving precedes the asset route. A file emitted under `dist/api/asset/`
  would be served before asset authentication and headers; the current build emits
  no `api/` directory.
- `/api/set_password` and `/api/crypto` are unauthenticated by design and rate
  limited. A server has one password and registered browser keys, not separate
  users. JWT validation does not check issuer, audience, `typ`, or `iat`, and a token without
  `exp` does not expire.
- `/proxy` and `/proxy2` can reach arbitrary targets; the local-network restriction
  applies to server streaming jobs. `/hub-proxy` is unauthenticated and forwards
  request headers other than `risu-auth` to the configured hub.
- Reverse proxies must preserve encoded path segments: decoding `%2F` can split a
  resource id containing a slash. Deployment behavior remains unverified.
- Other runtime limits and unresolved behavior belong to their subsystem owners:
  [chat-pipeline](chat-pipeline.md), [LLM requests](llm-requests.md),
  [memory](memory.md), [scripts and triggers](scripts-triggers.md),
  [plugins and MCP](plugins-mcp.md), and [CBS/rendering](cbs-rendering.md).
