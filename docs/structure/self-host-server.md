# Self-Host Server (Hono on Node), Docker

## Scope

- Owns:
  - `server/src/**`: the Hono self-host server on Node (`@hono/node-server`). Handles static `dist`, auth, asset storage, the resource store and its routes, resource snapshots and backup archives, the reverse proxy, the hub proxy, and streaming proxy jobs over WebSocket.
  - Local TLS certificates.
  - Docker packaging.
  - The launcher scripts.
  - The client/server contract, seen from the server side.
- Paths: `server/{src/**,tsconfig.json,ssl/*}`, `Dockerfile`, `.dockerignore`, `server.sh`, `server.bat`.
- Client counterparts, owned by other guides:
  - `src/ts/storage/nodeStorage.ts` → `persistence.md`.
  - `globalApi.svelte.ts` `fetchNative`/`fetchViaProxyJobWs` → `global-api.md`.
  - `characterCards.ts` `hubURL` → `characters-modules.md`.

## Files

The server is TypeScript run directly by Node's type stripping (`pnpm runserver` = `node server/src/main.ts`, Node `>=24`). There is no build step. Layout: `main.ts`, `app.ts`, and `types.ts` (`AppEnv`) at the root; route modules in `routes/`; the resource data layer in `data/`; shared HTTP helpers in `http/`; the server-side processing modules in `prompt/`, `scripts/`, and `lua/` (Phase 5); tests and their support in `tests/`. The server may import the persisted types in the root `shared/` folder (`persistence.md`); `server/tsconfig.json` includes it, so `pnpm check` strict-checks it. Relative imports use explicit `.ts` extensions, and only erasable syntax is allowed (`server/tsconfig.json` sets `erasableSyntaxOnly`; `pnpm check` runs `tsc -p server/tsconfig.json`).

- `server/src/main.ts`: entry. Reads `PORT` (default 6001), `TRUST_PROXY`, and `RISU_MAX_IMPORT_BYTES`, loads the TLS certificate (`getHttpsOptions`), calls `serve()`, attaches the WebSocket upgrade handler, and starts job GC and the snapshot timer. On SIGINT/SIGTERM it begins shutdown, drains HTTP for up to 8 s, force-closes remaining connections, then awaits `dispose()` and exits. `cwd` is the root: `cwd/dist`, `cwd/save`, `cwd/server/ssl/certificate`.
- `server/src/app.ts` `createServerContext({ rootDir, trustProxy, resourceKinds, snapshotIntervalMs, maxImportBytes })`: builds the Hono app and owns all state, including the resource store and the snapshot manager. `resourceKinds` replaces `DEFAULT_RESOURCE_KINDS` and `snapshotIntervalMs` the 10-minute interval (tests use them). Returns `{ app, snapshots, scriptWorkers, attachWebSocket, startBackgroundTasks, beginShutdown, dispose }`; `beginShutdown` stops admissions and timers; `dispose` is async and idempotent (it terminates the script workers and waits for admitted resource handlers and backup operations before closing the store). `app.request()` works for in-process checks, but it has no Node socket, so the client IP is undefined there.
- `server/src/routes/auth.ts` `createAuthStore`: `save/server/password` plus `save/server/known_public_key_hashes.json`, `verifyJwt`, `checkAuth`, `checkProxyAuth`, `isAuthorizedProxyToken`, and the `/api/test_auth|login|crypto|set_password` routes.
- `server/src/routes/storage.ts`: the key-to-file mapping (`STORAGE_NAMESPACES` = `assets` only, `decodeKeyHeader`, `encodeFileName`/`decodeFileName`, `isAssetStorageKey`, `resolveStorageKey`) and `/api/read|write|list|remove`. `registerStorageRoutes` empties `save/.tmp/` at startup; writes and removals hold the maintenance gate.
- `server/src/data/resourceStore.ts` `createResourceStore({ file, kinds })`: typed resource documents in one `node:sqlite` database (`save/data/resources.sqlite`), with revision tokens, conditional writes, `epoch`/`assertEpoch`, `writeCount`, `readKinds(kinds, { chats })`, `readRefs(refs, { chats, chatCollections })`, `applyBatch`/`applyChanges` (resource ops, chat groups, and reorders in one transaction), `transaction`, `backupTo` (online backup to a single-file copy), `readSnapshot` (validates a snapshot file) and `replaceAll` (installs it with a new epoch), the normalization pass (`normalizeStoredRecords`, run when the store opens and inside `replaceAll`), `ResourceConflictError`, `ResourceBatchConflictError`, `ResourceEpochError`, `ResourceValidationError`, `ResourceStoreClosedError`, and `isValidResourceId`.
- `server/src/data/chats.ts`: the pure chat normalizers: `normalizeChatMeta` (drops `message` and the streaming flags, sets `id`, defaults `name`/`note`/`localLore`, type-checks them and `fmIndex`), `normalizeMessage` (`user`/`char` role, string `data`, valid `chatId`), `normalizeMessageList` (a whole chat's messages: missing, invalid, or duplicate ids get UUIDs), `assertPatchableMetaKeys`, `CHAT_SCHEMA_VERSION`.
- `server/src/data/chatStore.ts`: the chat tables (`chats`, `messages`, `chatOrders`) inside the resource store: batch preparation before any transaction (`prepareChatGroups`, `prepareChatOrders`, `countChatOperations`: shapes, legal op combinations, normalization, errors prefixed `chats[i].ops[j]`), `createChatTables` (applies groups and reorders inside the store's transaction, reads, restore), the generation fence, and `readChatSnapshotRows` (snapshot validation).
- `server/src/data/kinds.ts`: `ResourceKind<T>` (name, `schemaVersion`, `singleton`, `materialize`, `clientReadable`, pure and idempotent `normalize(input, { id })`), `createKindRegistry` (reserves `batch` and `read`; a `materialize` kind must be a singleton), and `DEFAULT_RESOURCE_KINDS`. Phase 1 kinds (`root` was removed in Phase 3): `presets`, `modules`, `plugins`, `pluginStorage`, `pluginPermissions` (singletons, id `main`), `characters`, `inlays`, with minimum-shape normalizers that return the input unchanged, except `presets`, which gets `normalizePresets` (`shared/presets.ts`) and is materialized (one default preset). A `characters` record may not hold `chats` (chats are their own tables); `chat` and `chatOrder` are reserved kind names (conflict discriminators). Phase 3 kinds (singletons, `materialize`): the sections `providers`, `secrets`, `llmSecrets` (`clientReadable`), `ui`, `memoryTranslateMedia` and the collections `loreBook`, `globalscript`, `hotkeys`, `customSidebarItems`, `characterOrder`, `authRefreshes`, `globalChatVariables`, `personas`, `translatorPresets`, `hypaV3Presets`, `customModels`, `enabledModules`, `statics` (`shared/sections.ts`).
- `server/src/data/normalize/`: the Phase 3 normalizers, pure and returning new objects. `shared.ts` (`normalizeSection`: every field of `SECTION_FIELDS[section]` in order, its value when it has the field's JSON kind and its fresh-boot default otherwise, no other key; `requireObject`, `requireArrayOfObjects`), one file per section with its `SectionSpec` (each field's kind and the default from `src/ts/storage/tests/fixtures/phase3/boot-snapshot.json`) and the `setDatabase` migrations it owns (`providers`: the keep-on-switch containers; `secrets`: `hypaCustomSettings`; `llmSecrets`: `google`, the `presets` map of `{ proxyKey }` by preset id; `memoryTranslateMedia`: the NAI v4 fields; `ui`: `customColorScheme`, the quote colors, the chat load pages), `personas.ts` (id backstop, a repeated id re-keyed), `presets.ts` (`normalizePresets`), and `collections.ts` (the rest: shape checks, the `hotkeys` merge of `defaultHotkeys` by `action`, `statics` counters, and the `{ items, selectedId }` records of `translatorPresets` and `hypaV3Presets`, whose `selectedId` falls back to the first item). Each accepts `undefined` (materialization) and returns the fresh-boot value; a record or element of the wrong container shape is rejected.
- `server/src/data/snapshots.ts` `createSnapshotManager`: periodic snapshots under `save/backups/`, the lock every whole-database operation takes (`exclusive`), `withMaintenance` (closes the `MaintenanceGate`, waits for admitted storage mutations), `track` (admits a resource handler or backup operation; refused after `stop`), `list`, `resolve`, `snapshotNow`, `start`, `stop`. `MaintenanceError` answers 503.
- `server/src/data/archive.ts`: the backup archive container (`encodeRecordHeader`, `indexArchive` with record-count and name-byte caps, `readRecord`, `copyRecordToFile`).
- `server/src/routes/resources.ts` `registerResourceRoutes`: `/api/resources` (multi-kind read), `/api/resources/read`, `/api/resources/batch`, `/api/resources/:kind[/:id]`.
- `server/src/routes/backups.ts` `registerBackupRoutes`: `/api/backups` (list), `/api/backups/:id/restore`, `/api/backups/export`, `/api/backups/import`.
- `server/src/routes/proxy.ts`: `/proxy`, `/proxy2`, `/hub-proxy/*`. `ownBody` re-streams an upstream body and keeps the timeout alive until the body ends.
- `server/src/routes/proxyStreamJobs.ts` `createProxyStreamJobs`: the job map, `sanitizeTargetUrl`, `isLocalNetworkHost`, `requestLocalTargetStream` (Node `http`/`https`), the POST/DELETE routes, the `ws` upgrade handler, and GC.
- `server/src/http/rateLimit.ts` `createRateLimiter`: an in-memory limiter that reproduces the former express-rate-limit v8 setup (see Invariants).
- `server/src/http/clientIp.ts`: `parseTrustProxyEnv`, `compileTrust` (Express semantics), and `getClientIp` (`proxy-addr` over `c.env.incoming`).
- `server/src/http/body.ts` `readJsonBody`: JSON body parsing with Express-like defaults.
- `server/src/prompt/tokenizers/`: the client's tokenizer families under Node (Phase 5 slice 1). `createTokenizers({ rootDir })` (`load`, `encode`, `count`, a terminal `dispose`) loads each family on first use from `public/token/` or `dist/token/` (`payloads.ts`), through `@dqbd/tiktoken` (`tiktoken.ts`), a `vm` shim of `@mlc-ai/web-tokenizers` whose factory calls run one at a time (`webTokenizers.ts`), or Transformers.js `GemmaTokenizer` (`gemma.ts`). `node server/src/prompt/tokenizers/loadAll.ts [rootDir]` is the per-family smoke. Nothing calls it yet; slice 4 maps models to families.
- `server/src/scripts/workerPool.ts` `createScriptWorkerPool({ rootDir, size, maxSize, idleMs, resourceLimits, egress, wallMs })` (Phase 5 slice 2): the `worker_threads` pool that runs Lua and user regexes (`runLua(task, { host, signal, budget })`, `regex(op)`, `warm`, `stats`, `dispose`); results never throw. A worker runs one top-level task; a regex its run's host call spawns (`HostContext.regex`) goes to the same worker, and a host context stops working when its run ends. The watchdog charges the worker thread's busy time (`eventLoopUtilization`), less synchronous answers and spawned regexes, and terminates the worker past the CPU budget plus 1 s; a Lua task has a 10-minute wall cap and a regex a 1,000 ms deadline. An abort sets a shared flag the Lua hook reads. Budgets (`createLuaBudget`) reserve each run's allowance at its start. Terminated or crashed workers fail their tasks and abort their host calls. `size` (2) workers stay once started, up to `maxSize` (6) while all are busy; the queue holds 1,000 tasks. Host answers must be primitives (structured data crosses as a JSON string, since a JS object would reach Lua as a live proxy); inputs, results, logs, and regex results are capped. Synchronous host functions block the worker (`Atomics.wait`) until the main thread answers. `json.lua` resolves from `public/lua/` or `dist/lua/`. `createServerContext` creates it (workers start on the first task) and disposes it. `node server/src/scripts/smoke.ts [rootDir]` runs the spike's checks.
- `server/src/scripts/worker.ts`: the worker entry (one wasmoon module, the message protocol, the synchronous host-call wait, fault attribution, and `runRegexOp`: `test`, `exec`, `split`, `matches`).
- `server/src/lua/runtime.ts` `createLuaRuntime`: the engine lifecycle inside a worker: prepared one-use engines (two), one count hook per wasm module that raises when the run is aborted or its budget is spent (the worker's busy time; wasmoon's own `functionTimeout` is not used), `LUA_HARDENING` (no `io`, `debug` only `traceback`, no file or process functions of `os`, `require` only for `json`, text chunks only, `print` to the log sink), the client's prelude (`LUA_PRELUDE`), the mode dispatch, only primitives entering Lua (host answers, `onButtonClick` data), a value guard at wasmoon's push (an error becomes its message string, any other object a copied table, never a live proxy), the 64 MiB Lua heap cap, and the per-run CPU budget (3,000 ms; `sleep` 2 s per call and 6 s per run).
- `server/src/lua/egress.ts`: the guard of Lua `request` (`validateEgressUrl`, `isBlockedAddress` over `ipaddr.js`, the pinned HTTPS fetch without redirects, one 10 s deadline, `createRequestLimiter`: 30 validated requests per minute per server, 2 MB).
- `server/ssl/Generate Certificate.sh|.bat`, `ca.conf`, `server.conf`: generate a local CA and server certificate into `server/ssl/certificate/` (run from `server/ssl/`). `main.ts` uses HTTPS when `server.key`/`server.crt` exist there, relative to `cwd`.
- `Dockerfile`: Node 24, pnpm 10.34.1, multi-stage build of `dist`. Copies `server/` + `shared/` + `dist/` + prod `node_modules`, `EXPOSE 6001`, `CMD node server/src/main.ts` (Node is PID 1, so `docker stop` reaches its graceful shutdown; `pnpm runserver` would exit without waiting).
- `server.sh`/`server.bat`: install, build, run. The runtime env exports are commented out.

## Routes

Registration order in `createServerContext`:

1. `onError` (`HTTPException` responses pass through; maintenance and a closed resource store answer 503 with `Retry-After`; other errors are a 500 `Internal Server Error`). Shutdown admission middleware runs before body parsing, tracks resource handlers, refuses new resource and backup requests with 503, and adds `Connection: close` to every response during shutdown.
2. `bodyLimit` (100 MiB, 413 `{error:"Request body too large"}`), skipped only for `POST /api/backups/import`, which streams its body to disk under its own cap.
3. `GET /` and `GET /index.html` (one shared handler).
4. `serveStatic` for every other GET/HEAD.
5. The routes below.

Routing is non-strict (a trailing slash matches).

| Method     | Path                                    | Auth                                                                         | Rate limit     | Purpose                                                                                                                                                                                       |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET/HEAD   | `dist/*`                                | none                                                                         | none           | built frontend (`@hono/node-server` `serveStatic`: ranges, `Last-Modified`, no ETag)                                                                                                          |
| GET        | `/`, `/index.html`                      | none                                                                         | none           | serves `dist/index.html` with `globalThis.__NODE__ = true` injected after the `<head>` tag                                                                                                    |
| GET/POST   | `/proxy`, `/proxy2`                     | `checkProxyAuth` (stored password in `risu-auth`, or a registered ES256 JWT) | 2000/min       | arbitrary reverse proxy (`risu-url`, `risu-header`)                                                                                                                                           |
| GET        | `/hub-proxy/*`                          | none                                                                         | 2000/min       | proxies to `x-risu-node-path` or `https://sv.risuai.xyz`                                                                                                                                      |
| POST       | `/proxy-stream-jobs`                    | `checkProxyAuth`                                                             | 2000/min       | creates a local-network streaming job. `sanitizeTargetUrl` allows local/private targets only. Body ≤ 8 MiB base64, ≤ 64 active jobs.                                                          |
| DELETE     | `/proxy-stream-jobs/:jobId`             | yes                                                                          | 2000/min       | aborts a job                                                                                                                                                                                  |
| WS upgrade | `/proxy-stream-jobs/:jobId/ws`          | `risu-auth` query or header                                                  | none           | event stream (`ProxyJobWsEvent`)                                                                                                                                                              |
| GET        | `/api/test_auth`                        | none                                                                         | 2000/min (own) | returns `unset`, `incorrect`, or `success`                                                                                                                                                    |
| POST       | `/api/login`                            | password digest                                                              | 10 per 30 s    | registers a public-key hash                                                                                                                                                                   |
| POST       | `/api/crypto`                           | **none**                                                                     | **none**       | SHA-256 of `body.data` (text/plain)                                                                                                                                                           |
| POST       | `/api/set_password`                     | **none**, only works while unset                                             | **none**       | first-run password setup                                                                                                                                                                      |
| GET        | `/api/read`, `/api/remove`, `/api/list` | `checkAuth` (JWT)                                                            | 2000/min       | storage. The `file-path` header is the hex UTF-8 key; `remove` takes `$$`-joined hex keys.                                                                                                    |
| POST       | `/api/write`                            | `checkAuth`                                                                  | 2000/min       | storage write, raw body bytes                                                                                                                                                                 |
| GET        | `/api/resources?kinds=a,b[&chats=1]`    | `checkAuth`                                                                  | 2000/min       | `{ epoch, kinds: { <kind>: [{ id, revision, data }] }, chats?, chatOrders? }`, one committed state; 400 for an unknown or missing kind                                                        |
| POST       | `/api/resources/read`                   | `checkAuth`                                                                  | 2000/min       | body `{ refs?, chats?: [{ characterId, id }], chatCollections?: [characterId] }` (1-5000 in all); `{ epoch, items, chats?, chatCollections? }` (null for a missing record or chat)            |
| POST       | `/api/resources/batch`                  | `checkAuth` + epoch                                                          | 2000/min       | body `{ ops?, chats?, chatOrders? }` (1-5000 operations, nested chat ops counted, see Invariants); `{ epoch, results, chats?, chatOrders? }`; 409 `{ error, conflicts }` with nothing applied |
| GET        | `/api/resources/:kind`                  | `checkAuth`                                                                  | 2000/min       | `{ epoch, items: [{ id, revision, data }] }` in creation order; 404 for an unknown kind                                                                                                       |
| GET        | `/api/resources/:kind/:id`              | `checkAuth`                                                                  | 2000/min       | `{ epoch, revision, data }`; 404 when missing, 400 for an invalid id                                                                                                                          |
| PUT        | `/api/resources/:kind/:id`              | `checkAuth` + epoch                                                          | 2000/min       | body `{ baseRevision: string \| null, data }`; `{ epoch, revision, data }` as stored; 409 `{ error, revision }` on a stale revision                                                           |
| DELETE     | `/api/resources/:kind/:id`              | `checkAuth` + epoch                                                          | 2000/min       | `?baseRevision=<token>`; `{ success: true, epoch }`; 409 `{ error, revision }` when stale or already gone; 400 for a singleton                                                                |
| GET        | `/api/backups`                          | `checkAuth`                                                                  | 2000/min       | `{ items: [{ id, createdAt, size }] }`, newest first                                                                                                                                          |
| POST       | `/api/backups/:id/restore`              | `checkAuth` + epoch                                                          | 2000/min       | replaces every resource with the snapshot (safety snapshot first); `{ epoch }`; 404 unknown id, 400 invalid snapshot                                                                          |
| POST       | `/api/backups/export`                   | `checkAuth`                                                                  | 2000/min       | body `{ partial?: string[] }` (asset keys); streams an archive (see Flows); 413 when it cannot fit the format                                                                                 |
| POST       | `/api/backups/import`                   | `checkAuth` + epoch                                                          | 2000/min       | raw archive body (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`, default 16 GiB); `{ epoch, assetsWritten, assetsSkipped }`; 400/413                                                              |

"+ epoch" means the `x-resource-epoch` header must name the current database epoch (412 `{ error: "EpochMismatch", epoch }` otherwise). Mutations answer 503 with `Retry-After` while a restore or an import runs. During shutdown, new resource requests (including reads) and backup requests also answer 503 with `Retry-After`; a typed store-closed error maps to the same retryable response. Every `/api/resources` response is `Cache-Control: no-store`.

The storage, resource, proxy, and job rows marked "2000/min" share one limiter; `test_auth` has its own. Login has its own.

## Flows

Boot:

1. `pnpm runserver` runs `node server/src/main.ts`.
2. `createServerContext` creates `save/` if missing. `createAuthStore` creates `save/server/` and loads `password` and `known_public_key_hashes.json` from it. `registerStorageRoutes` recreates `save/.tmp/` empty.
3. `serve()` listens on HTTPS or HTTP. A listen error (e.g. `EADDRINUSE`) logs and exits 1.

Client detection:

1. `GET /` and `GET /index.html` inject `__NODE__`, which makes `isNodeServer` true in the client. Without it the client shows only the `NodeServerRequired` notice, so no route may serve `index.html` raw.
2. `AutoStorage` always uses `NodeStorage`.

Development (`pnpm dev`):

1. Run `pnpm runserver` and `pnpm dev` side by side. The Vite dev server (port 5174) injects `__NODE__` into its own `index.html` (plugin `risu-node-flag`, serve only) and proxies `/api`, `/proxy`, `/proxy2`, `/hub-proxy`, and `/proxy-stream-jobs` (including the WS upgrade) to `RISU_DEV_SERVER` (default `http://localhost:6001`; set `https://...` when the server found a certificate).
2. The dev origin keeps its own IndexedDB `DPoPDB` key pair, so it logs in separately from the server origin.
3. The server sees every proxied request as coming from the Vite process, so all dev clients share one rate-limit bucket (including the 10-per-30 s login limiter). The dev proxy does not add `X-Forwarded-For`, so `TRUST_PROXY` alone does not separate them.
4. `NodeStorage` needs `crypto.subtle`, so open the dev server via `localhost` (a plain-HTTP LAN address is not a secure context).

Auth:

1. `NodeStorage.checkAuth` creates an ES256 JWT (P-256, 5-minute expiry, public JWK). The key pair is kept in IndexedDB `DPoPDB`, entry `node`.
2. It calls `/api/test_auth`, then either `/api/set_password` followed by `/api/login` with the same digest (first run, so the first request is already authorized) or `/api/login`. One check runs at a time per `NodeStorage` instance.
3. Once logged in, the server knows the key hash, and later requests only send the JWT.

Resources and saving (client side: `persistence.md`):

1. The client reads every kind and every chat with one `GET /api/resources?kinds=...&chats=1` at boot and keeps the epoch.
2. Its save adapter sends one `/api/resources/batch` per save cycle: resource ops, chat groups (one per chat: its ops on the chat revision they were based on), and chat reorders. All of them are validated and normalized first, then every base revision is compared inside one transaction; any conflict rolls the whole batch back and the 409 lists all of them (resource conflicts, `kind: "chat"`, `kind: "chatOrder"`).
3. Chat groups: `create` (first op; the chat with its messages, inserted in the order at `index`), `delete` (alone), `replace`, `meta` (`set`/`unset` per field), `append` (at the end, the start, or after a message id), `setMessage`, `setText`, `remove`, `begin`. A group result carries the chat's new revision, the ids of messages it created, the outcome of each generation-carrying op (`applied`, `duplicate`, `ignored`), and `stale: true` when it applied on an older revision.
4. Deleting a character deletes its chats and chat order in the same transaction.
5. Inlays and plugin permission grants use the single-record routes.

Snapshots and restore:

1. `startBackgroundTasks` starts a timer (10 minutes). A tick takes a snapshot only when committed writes happened since the last one: `backupTo` writes `.<name>.tmp`, switches it to rollback-journal mode, and renames it to `resources-<UTC yyyymmddThhmmssmmmZ>-<8 hex>.sqlite`; the newest 20 are kept.
2. Restore (`/api/backups/:id/restore`) runs under maintenance: epoch check, `readSnapshot` (integrity check, layout version, real `resources`/`meta`/`chats`/`messages`/`chatOrders` tables with this store's columns and an epoch, then every row: registered kind at its schema version, valid id, singleton rules, unique kind and id, JSON the kind's normalizer accepts; every chat, message, fence, and order row, with each chat's parent character and each order a permutation of its chats; positions compacted), a safety snapshot, a second epoch check, then `replaceAll` in one transaction with a new random epoch. Every token issued before is stale afterwards.

Backup archives:

1. The container is concatenated records of `u32le nameLength`, the UTF-8 name, `u32le dataLength`, and the bytes. Version 2 starts with `manifest.json` (`{ version: 2, createdAt, partial, assets, missing }`), then `resources.sqlite` (a fresh copy), then each asset under its full key `assets/<name>`.
2. Export takes the database copy first, then lists the assets (every file of `save/assets`, or the `partial` keys), so every asset the copy references already exists. The copy lives in `save/.tmp/export-<uuid>/` and is removed once, when the stream ends, is cancelled, or the client left before it started. A listed asset that can no longer be read fails the stream.
3. Import authenticates and checks the epoch before reading the body, spools it to `save/.tmp/import-<uuid>/` with a byte count, then validates the whole archive before writing anything: manifest first and unique, the declared assets exactly the asset records, exactly one `resources.sqlite` that `readSnapshot` accepts, only `assets/` keys. Refused: a Risu Account archive (`encryption.risudat`), an archive from before version 2 (`database.risudat`), a truncated or malformed one. `coldstorage_*.json` records are ignored. Then, under maintenance: epoch check, safety snapshot, assets that do not exist yet are added by hard link (existing files are never overwritten), and `replaceAll`. One import at a time.

Shutdown:

1. `beginShutdown()` sets the shutdown flag, stops the snapshot timer and backup admissions, and disposes proxy jobs and limiters. Middleware refuses new resource and backup requests with 503 plus `Retry-After: 5`; every response during shutdown carries `Connection: close`, including a request admitted before the signal. Resource handlers are tracked before body parsing or auth and retain access to the open store. Backup operations retain their existing admission boundary.
2. `main.ts` awaits `server.close()` for at most 8 seconds, then calls `closeAllConnections()` before `dispose()`. Disconnects abort unfinished body reads and export streams; `dispose()` awaits admitted handlers and backup cleanup before closing the database. The deadline leaves cleanup time within Docker's default 10-second stop timeout.
3. In-process callers use `dispose()` alone: it runs the begin step and waits for admitted operations before closing. A leftover store access raises `ResourceStoreClosedError`, mapped by both resource routes and `onError` to 503 with `Retry-After`, including reads.

Proxying:

- The client sends `risu-url` and `risu-header` (encoded JSON) to same-origin `/proxy2`.
- The request body is forwarded as raw bytes. `HEAD` fetches upstream with GET and returns headers only.
- Upstream request headers (`buildUpstreamHeaders`, case-insensitive):
  - The decoded `risu-header` must be a JSON object. Anything else is a 500.
  - Stripped: `host`, `connection`, `keep-alive`, `proxy-connection`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `content-length`, `risu-auth`, and every field named in `Connection`. A `Connection: authorization` therefore drops `Authorization`.
  - `x-forwarded-for` is added only when absent.
- `/hub-proxy` forwards the incoming headers minus `host`, `connection`, `content-length`, `x-risu-node-path`, and `risu-auth`, and sets `origin`.
- `/proxy` and `/proxy2` response headers drop CSP, `clear-site-data`, `cache-control`, `content-encoding`, `content-length`, and `transfer-encoding`.
- On `/proxy` and `/proxy2`, `risu-timeout-ms` covers the whole exchange (`/hub-proxy` has no timeout):
  - Before upstream headers it returns 504 `{error}`.
  - Mid-stream it ends the response cleanly.
- A client disconnect aborts the upstream fetch on `/proxy`, `/proxy2`, and `/hub-proxy`. Proxy stream jobs are different: a WebSocket client disconnecting does not abort the job; only DELETE, the deadline, GC, or `dispose()` does.
- Node local-network streaming uses the job and WebSocket protocol with events `job_accepted`, `upstream_headers`, `chunk` (base64), `error`, `done`, and `ping`. Heartbeat is 5–60 s. Jobs have a 30 s done-grace period.
- Stream-job targets must pass `sanitizeTargetUrl`/`isLocalNetworkHost` (`ipaddr.js` ranges):
  - allowed: `localhost` and `*.local`;
  - IPv4 in 10/8, 172.16/12, 192.168/16, 127/8, 0/8, or 169.254/16;
  - IPv6 in fc00::/7 or fe80::/10, `::1`, and IPv4-mapped forms of those IPv4 ranges (bracketed URL hosts are accepted).
  - Single-label hosts other than `localhost` are rejected, although the client's `localNetwork.ts` treats them as local. The client also rejects IPv4-mapped IPv6.
- Stream-job forwarded headers are lowercased, then `risu-auth`, `risu-timeout-ms`, `host`, `connection`, and `content-length` are dropped.
- DELETE, the deadline, GC cleanup, and `dispose()` abort the job's upstream request and response even after upstream headers arrived. Deadline cancellation can deliver an `error` event to connected clients (`proxyJobWs.ts` shows every 504 as a timeout). DELETE, GC cleanup, and `dispose()` close the WebSockets without guaranteeing a final event.

### Changes from the former Express server

- `/proxy` and `/proxy2` POST forward raw bytes. Express re-serialized parsed JSON and turned urlencoded bodies into `"{}"`.
- `risu-auth` is never forwarded upstream by `/proxy`, `/proxy2`, or `/hub-proxy`, and header stripping is case-insensitive.
- `HEAD` on `/proxy` and `/proxy2` returns headers only and closes the upstream.
- The proxy timeout spans the streamed body; a mid-stream timeout ends the response cleanly.
- A client disconnect aborts `/proxy`, `/proxy2`, and `/hub-proxy` upstreams.
- Batch `/api/remove` works. A missing `file-path` is a 400; Express never answered it.
- JSON bodies: malformed, whitespace-only, or primitive JSON is a 400. `set_password` persists before updating memory. Zero-length `/api/write` bodies are written.
- Stream-job targets use `ipaddr.js` ranges, which adds bracketed and IPv4-mapped IPv6 literals. Stream-job DELETE, deadline, GC, and dispose stop active upstreams.
- Static files use `@hono/node-server` `serveStatic`:
  - supported: ranges and `Last-Modified`;
  - no ETag, conditional requests, or `Cache-Control`;
  - a directory path serves its `index.html`, where Express had `index: false`.
- `/api/read` has no ranges or ETag.
- No request decompression or charset-aware decoding; JSON text is read as UTF-8.
- `/api/crypto` and `already set` are `text/plain`, not `text/html`. The 404 and 500 bodies are plain text.
- Paths are case-sensitive, a trailing slash is tolerated, and there is no automatic `OPTIONS`.

## State

Disk, under `save/`:

- `server/password`: the client-side SHA-256 digest via `/api/crypto`.
- `server/known_public_key_hashes.json`. Deleting only `password` lets you set a new one but does not revoke registered clients; delete this file too for that.
- `.tmp/`: staged writes and the per-operation export/import staging folders, emptied at startup.
- `data/resources.sqlite` (plus its `-wal` and `-shm` files): the resource store. Table `resources` (`seq` autoincrement, `kind`, `id`, `revision`, `schemaVersion`, `data` JSON text, unique `(kind, id)`), table `meta` holding the random `epoch`, table `chats` (`seq`, `characterId`, `id`, `revision`, `schemaVersion`, `meta` JSON), table `messages` (`chatSeq`, message `id`, integer `position`, `data` JSON, and the generation fence: `generationId`, `generationSeq`, `generationFinal`, `generationHistory` of up to 8 earlier ids), and table `chatOrders` (`characterId`, `seq`, `revision`, `ids` JSON); `PRAGMA user_version` is the store version (3: the Phase 3 sections and collections, no `root` record; the tables are those of version 2). Opening the store and every `replaceAll` run the normalization pass in one transaction: each record whose normalized text or schema version differs from the stored one is rewritten with its revision counter advanced (same `seq` and epoch), and each missing `materialize` singleton is created; a stored record its normalizer rejects, or one of a newer schema version than its kind, stops the start. A version-1 file (Phase 1) or version-2 file (settings in a `root` record, before Phase 3) is refused at startup with a message naming it, and a snapshot or archive of another version is refused on restore; there is no migration. The connection runs with `journal_mode=WAL`, `busy_timeout=5000`, and `foreign_keys=ON`. `data/` is not a storage namespace.
- `backups/`: resource snapshots (`resources-*.sqlite`, single files, newest 20), not a storage namespace. Assets are not in snapshots.
- User files: a logical key `assets/<name>` lives at `save/assets/<encodeFileName(name)>`, e.g. `assets/<sha>.png` or `assets/inlay_<sha256>.png`. The `save/database` and `save/remotes` folders of versions before Phase 1 are left in place and no longer read.
  - `encodeFileName` keeps `a-z 0-9 . _ -` readable and writes every other UTF-8 byte (uppercase letters, `/`, `%`, spaces, non-ASCII) as `%XX`. It also escapes a trailing dot and the first character of a Windows device name (`con.png` → `%63on.png`). A name whose readable form exceeds 255 bytes is stored as `~<lowercase hex>`; longer than that is rejected.
  - Only one encoding per name is canonical, and canonical names never differ by case alone, so case-insensitive filesystems do not merge keys.
  - The old flat layout (hex file names and `__password` directly in `save/`) is not read and was not migrated.

Process memory, inside the `createServerContext` closure:

- `password` and the known key hashes.
- The proxy stream job map.
- Rate-limit counters.
- The resource store's epoch and committed-write counter, the snapshot lock, the maintenance gate, and the import-in-progress flag.

## Coupling

- Server dependencies:
  - `hono` and `@hono/node-server`.
  - `ws`, for the upgrade handler.
  - `proxy-addr` and `ipaddr.js`.
  - Node `crypto`/`fs`/`http`/`https`/`net`/`sqlite`.
  - All of the above are prod dependencies because the Docker runtime stage installs `--prod`.
- Client dependencies that use this server: `NodeStorage`, `AutoStorage`, `globalApi` proxy code, `characterCards.hubURL` (`/hub-proxy`), `util.ts` DPoP storage.

## Invariants

- Phase 4 (external contracts) changed no route, kind, table, or normalizer: the client mutation modules write the same records through the same batch route.
- Storage routes never use a raw path. `decodeKeyHeader` requires even-length hex and valid UTF-8 (verified by an exact byte round trip), then `resolveStorageKey` requires a namespace from `STORAGE_NAMESPACES` (only `assets`) and encodes the whole rest of the key, `/` included, into one file name. Only these folders are reachable; `save/server/` and `save/.tmp/` are not.
- Unsupported keys: malformed hex/UTF-8 is 400 `Invaild Path` on every route. A well-formed key with no storage location (other namespace, empty or too-long name) reads as missing (empty 200, no disk access), because the client reads whatever paths an old database stored; `write` and `remove` reject it with 400.
- `/api/list` returns only regular files whose names are canonical `encodeFileName` output, so every listed key reads back the same file. Other entries (subfolders, symlinks, noncanonical file names) are ignored.
- Keep the logical keys and the hex wire encoding; the client depends on both. The mapping to file names must stay reversible and injective.
- Keep these unchanged:
  - the `__NODE__` injection;
  - the `risu-*` header names and `x-risu-node-path`;
  - status codes and JSON error bodies, including the `Invaild Path` typo (one deliberate change: a `/api/read` filesystem error other than a missing file, symlink, or non-regular file is now a 500 instead of an empty 200);
  - the 100 MiB body limit (the backup import is the one route exempt from it).
- Rate limits must keep matching the former express-rate-limit v8 setup:
  - thresholds as in the Routes table;
  - windows start at a key's first hit;
  - IPv4-mapped IPv6 keys collapse to IPv4, other IPv6 addresses to their /56;
  - draft-6 `RateLimit-*` headers, plus `Retry-After` on 429.
- `TRUST_PROXY` keeps Express `trust proxy` semantics via `compileTrust`:
  - a number is a hop count;
  - a string is a comma list for `proxy-addr` (`loopback`, CIDRs, ...);
  - an invalid value fails at startup.
- `JSON` routes (`readJsonBody`):
  - a non-JSON content type or a zero-length body is `{}`;
  - malformed JSON (including whitespace only) or a top-level primitive is 400 `{error:"Invalid JSON body"}`.
- Streaming job protocol: the event names, base64 chunks, authentication on the WebSocket upgrade, and timeouts must all match `src/ts/network/proxyJobWs.ts` and `fetchViaProxyJobWs`.
- The WebSocket upgrade handler is `ws` attached directly to the server returned by `serve()`. Do not also pass `websocket` to `serve()` or add `@hono/node-ws`: two upgrade listeners conflict.
- Resource revisions: a token is `<epoch>:<seq>:<revision>`, opaque to clients. A write matches all three parts, so a token from another database epoch, or from a deleted and recreated record (new `seq`), never passes. `baseRevision: null` creates and conflicts if the record exists; a write to a missing record is a 409 with `revision: null`. A token string that does not parse, including an empty `?baseRevision=`, is a 409 with the current revision; a `baseRevision` of the wrong JSON type, or a DELETE without the query parameter, is a 400.
- Resource writes normalize inside the store: `put` runs the kind's `normalize` once and stores its JSON result. A normalizer sees the stored form of its input (`serialize` runs first), so a nested non-finite number or over-deep input is refused before a JSON copy inside the normalizer could hide it. Reads never normalize; a new default or migration reaches stored records only through the normalization pass at the next start, so every normalizer must be idempotent (its output normalizes to the same JSON) or the pass rewrites that record on every start. The store is built with the kind registry and every method refuses a kind object the registry does not hold, so no caller can swap in another normalizer. A value is stored as `JSON.stringify` produces it (`toJSON` applies, `undefined` fields drop, Dates become strings, `-0` becomes `0`), and `put` and later reads return that stored form. `put` refuses, with `ResourceValidationError` (400), data whose JSON form would turn a non-finite number into `null` (`1e400` parses to `Infinity`), data `JSON.stringify` cannot serialize (a bigint, a cycle, a throwing getter, runaway nesting), and a JSON form nested deeper than 256 levels. `transaction(fn)` is one synchronous `BEGIN IMMEDIATE`; a throw, or any conflict inside it even if `fn` caught it, rolls back every write. A body whose return type can be a promise does not type-check (`TransactionBody`, best-effort: a body returning `any` passes, and an overloaded function reference is judged by its last overload, so wrap it in a zero-argument arrow), and at runtime a returned promise or thenable rolls back and throws. An `AsyncLocalStorage` scope follows the work the body starts through awaits, promise continuations, and timers: once the body returns, a write from that work throws, so it cannot autocommit after a rollback. Callbacks the body registers on an event emitter do not carry the scope and are not covered. Never await inside a transaction.
- Resource ids: 1-512 UTF-16 code units of well-formed Unicode, no control character, not `.` or `..`; clients encode them once with `encodeURIComponent` (so `§playground` and `assets/x.png` are valid ids). A singleton kind accepts only `main` and cannot be deleted.
- Epoch fencing: every mutation (PUT, DELETE, batch, restore, import) names the epoch in `x-resource-epoch`, checked in the same synchronous block as the write (restore and import check again inside maintenance), so nothing based on data from before a restore lands, including a create with `baseRevision: null`. Reads return the epoch; tokens stay opaque.
- Batch operations are `{ kind, id, baseRevision, data }` or `{ kind, id, baseRevision, delete: true }` (a string base revision); duplicates of one kind and id, both or neither of `data`/`delete`, unknown kinds, and invalid ids are 400 with the operation index.
- Chat groups (`chats[i]`): one per chat; `baseRevision` is null exactly for a group that starts with `create`; `create` only first and `delete` only alone; a batch that deletes a character and names its chats is 400. Every validation error names the group and op (`chats[i].ops[j]: ...`), including data refused only once merged inside the transaction (a `meta` patch), so a client can quarantine that one chat. A chat create under a missing character is a 409 chat conflict with revision null.
- Chat revisions: every applied op moves the chat's revision (a replayed or no-op op does not). By-id ops (`append`, `setMessage`, `setText`, single `remove`, `meta`) apply to an older revision of the same chat incarnation while their message exists; `replace`, `delete`, a multi-id `remove`, reorders, and a `begin` of an unknown generation need the current revision (a `begin` on a message appended in the same group does not). Replays are idempotent: an identical `append` of an existing id and a single `remove` of a missing message are no-ops; an `append` of an existing id with other content is a 409.
- Reorders (`chatOrders[i]`: `{ characterId, baseRevision, ids }`) compare the order revision from before the batch; `ids` must be a permutation of the character's chats (400 otherwise).
- Generation fence (per message): `begin` takes the message over for a generation id (the previous id goes to the history). A write carrying `{ id, seq, final? }` is `applied` when it is the current generation with a higher `seq` and not final yet, `duplicate` when its `seq` was already applied, and `ignored` otherwise (another generation, or after `final`). A write without a generation closes an open fence. `replace` keeps the fences of surviving messages closed.
- Maintenance (restore, import) closes resource and storage mutations with 503 and waits for storage writes already admitted; a restore or export that arrives meanwhile waits for the lock instead.
- Backup import never overwrites an existing asset file; resources are replaced atomically, assets are only added.
- Docker persistence depends on `/app/save`. Removing the volume loses the password, registered keys, and all data.

## Recipes

- Add a storage operation:
  - Add a route in `routes/storage.ts` with `auth.checkAuth`, the shared limiter, `decodeKeyHeader`, and `resolveStorageKey`.
  - Add the matching `NodeStorage` method.
- Add a storage namespace: add it to `STORAGE_NAMESPACES`; the client key prefix is the folder name.
- Change auth:
  - Client: `NodeStorage.createAuth`/`checkAuth`/`digestPassword`.
  - Server: `routes/auth.ts` (`verifyJwt`, the `/api/login` route).
  - Verify first run, restart, token expiry, and unknown keys.
- Change proxy policy: server `sanitizeTargetUrl`, client `localNetwork.ts` + `fetchNative`.
- Change streaming: `routes/proxyStreamJobs.ts` (`runJob`, `attachWebSocket`, `onConnection`), `ProxyJobWsEvent`, `fetchViaProxyJobWs`, and `proxyJobWs.test.ts`.
- Add a resource kind: add a `ResourceKind` to `DEFAULT_RESOURCE_KINDS` with a pure, idempotent `normalize` (throw `ResourceValidationError` to reject), a `schemaVersion`, `singleton` if it has one record, and `materialize` if the store should create that record (then `normalize(undefined)` must return its default); the routes, snapshots, and archives pick it up. Add the kind name to `RESOURCE_KIND` in `shared/resources.ts` for the client.
- Change the archive format: `server/src/data/archive.ts`, `planImport` and the export in `routes/backups.ts`, `BackupArchiveManifest`, and the client reader in `src/ts/drive/backuplocal.ts`; bump the manifest version.
- Change packaging: `Dockerfile`, the README Docker steps, and `package.json` `runserver` together. Any new root folder the server imports at runtime (like `shared/`) needs a `COPY` in the `runtime` stage.

## Tests

- Server (`// @vitest-environment node`, type-checked by `pnpm check` through `server/tsconfig.json`):
  - `server/src/tests/app.test.ts`: `__NODE__` injection (`/` and `/index.html`), auth flow and JWT failure bodies, JSON rules, login limiter, storage layout (including `save/data/` and `save/backups/`) and key mapping (only `assets/`; `database/` and `remotes/` keys have no storage location), batch remove.
  - `server/src/tests/proxy.test.ts`: proxy auth, raw bodies, header filtering, SSE, timeout, HEAD, hub proxy.
  - `server/src/tests/proxyStreamJobs.test.ts`: target allowlist, job validation, a real `serve()` WebSocket lifecycle, DELETE and `dispose()` closing upstreams.
  - `server/src/tests/testSupport.ts`: temp-root context, ES256 signer, recording upstream.
  - `server/src/tests/resources.test.ts`: resource routes: round trip, stale and duplicate writes (409 with the current revision), envelope and token validation, epoch header, non-finite and over-deep data, normalizer rejection through the `resourceKinds` seam of `createTestServer`, list order, delete and recreate, unknown kind, invalid id, auth.
  - `server/src/tests/resourcesBatch.test.ts`: the batch route (all conflicts listed, nothing applied, variants, duplicates, singletons, 5,000 ops, 412), multi-kind and ref reads, relaxed ids end to end.
  - `server/src/tests/kinds.test.ts`: the default kinds' shape normalizers and reserved names.
  - `server/src/tests/snapshots.test.ts`: snapshot publish and retention, periodic only after committed writes, stop and lazy admission, the maintenance gate draining storage mutations.
  - `server/src/tests/backups.test.ts`: the version boundary (a fresh store at version 3; a version-2 file refused as an archive, as a snapshot, and at startup, leaving the data and the epoch unchanged), list, restore (invalid source leaves data untouched, queued restore gets 412), maintenance 503, export full/partial/missing/cancel paths, import round trip and refusals, never overwriting assets, caps, auth before the body, one import at a time, shutdown admission.
  - `server/src/tests/shutdown.test.ts`: the real `main.ts` answers an import admitted before SIGTERM and exits promptly on SIGINT.
  - `server/src/tests/resourceStore.test.ts`: revision tokens (epoch, incarnation, malformed), reopen and idempotent `close`, unregistered kind objects, the stored JSON form and its limits (non-finite numbers, unserializable values including a `Number` box whose conversion hook returns a bigint, 256/257 depth), and `transaction`: commit, rollback, nested, caught conflict, promise and thenable bodies, the ended-scope write rejection, plus the `TransactionBody` compile-time checks (`@ts-expect-error`, checked by the server `tsc`).
  - `server/src/tests/chats.test.ts`: the pure chat normalizers (`normalizeChatMeta`, `normalizeMessage`, `normalizeMessageList`, `assertPatchableMetaKeys`) and the batch preparation (`prepareChatGroups`, `prepareChatOrders`, `countChatOperations`): envelope shapes, the legal-combination rules, `needsCurrent`, every op's validation with its `chats[i].ops[j]` prefix.
  - `server/src/tests/chatStore.test.ts`: the chat store through `createResourceStore`: create with initial chats and order, mixed resource/chat/order atomicity and write accounting, character deletion cascades (single and batch, the delete-plus-chats 400), stale-by-id versus current-revision ops, incarnation and epoch tokens, reorder CAS against the pre-batch order and committed conflict revisions, positions (start/after/end, a 300-op array model), idempotent replay, the generation fence (seq order, final, manual close, takeover rules, history cap, replace keeping fences, same-group insertion), the revision-counter guard (`nextRevision`), and snapshots (validation of every chat row, position compaction, order `seq`, restore with fences, failed restore rollback).
  - `server/src/tests/resourcesChats.test.ts`: the chat parts of the resource routes: batch bodies with `chats`/`chatOrders`, the response spread, `GET ?chats=1`, `POST /read` with `chats`/`chatCollections`, the mixed 409 union with the shared guards, malformed envelopes and the nested-op cap, auth/epoch/maintenance fences, character deletion cascading over the DELETE route.
  - `server/src/tests/sharedImports.test.ts`: spawns plain `node` to import every `shared/**/*.ts` (the subfolders included), the runtime guard for the `.ts` import convention (type-only imports are erased before Node resolves them; the `nodenext` server `tsc` checks those).
  - `server/src/tests/cbs.test.ts` and `server/src/tests/regex.test.ts`: the shared CBS evaluator and regex engine under Node (`cbs-rendering.md`, `scripts-triggers.md`).
  - `server/src/tests/normalizeSections.test.ts`: the five section normalizers against the boot snapshot fixture (`undefined` and `{}` give the fresh-boot fields in `SECTION_FIELDS` order, unset fields stay absent), null and wrong-kind repair, unknown keys dropped, no mutation or aliasing, container rejection, idempotence after serialization, and each migration (keep-on-switch containers, `hypaCustomSettings`, `google` and the `proxyKey` map with own `__proto__` keys and its rejections, the vertex expiry, `customColorScheme` from `colorScheme`, the quote colors, the chat load pages, the NAI v4 fields).
  - `server/src/tests/normalizeCollections.test.ts`: the registry entries of every section and collection kind (materialized singletons, `llmSecrets` client-readable, materialized values as fixed points), the list and map collections (fresh-boot values, copies, shape rejections, `authRefreshes` optional fields, an own `__proto__` key in `globalChatVariables`, `statics` counters), the `hotkeys` merge by `action`, the `{ items, selectedId }` records of `translatorPresets` and `hypaV3Presets` (rebuild, id backstop and re-keying, selection fallback, the HypaV3 `__proto__` settings case), `personas`, and the `presets` collection.
  - `server/src/tests/normalizationPass.test.ts`: the pass through `createResourceStore`: a fresh store's materialized rows as fixed points, reopening without rewrites (epoch, tokens, generated ids), a legacy row rewritten once with its revision advanced and `seq` kept, tokens from before a restart (valid for an untouched record, stale for a rewritten one), a missing singleton recreated, schema versions (older rewritten, newer refuses the start and leaves the file), a rejected record stopping the start with the earlier rewrite rolled back and the file released, `replaceAll` materializing what a pre-slice snapshot lacks (not filled from `root`), a backup taken after the pass restoring unchanged, rollback of a restore whose pass fails, nested non-finite numbers refused by `put`, a batch, and `readSnapshot`, and a `presets` record carrying `proxyKey` and `openAIKey` rewritten once without them (ids and the `llmSecrets.presets` map kept; slice 7).
- In-process tests use `createServerContext({ rootDir: <tmp> }).app.request()` (no socket, so the client IP is undefined). Socket-level behavior (client IP, aborts, TLS, WebSocket) needs a real listening server. Await `dispose()` afterwards.
- Client helpers: `src/ts/network/proxyJobWs.test.ts`, `src/ts/network/localNetwork.test.ts`.
- No Docker tests. The Phase 0 check built the image and started it by hand (see the phase file).

## Known Hazards

- `put` validates a value's depth on its parsed JSON form, so an over-deep value is rejected only after it has been fully serialized and parsed. Over HTTP the body is already parsed and capped at 100 MiB; only in-process callers could pass costlier values (getters, `toJSON`).
- The resource store assumes one server process and a local filesystem for `save/data/` (SQLite WAL uses shared memory; network filesystems are unsupported). Snapshots cover only `save/data/`; deleting both `save/data/` and `save/backups/` loses every resource.
- Snapshots do not hold assets, and inlay blobs are never deleted (a retained snapshot may reference them), so `save/assets/` only grows. Restoring the oldest retained snapshot can evict that file through the safety snapshot's retention (it was read in full first, so the restore itself succeeds).
- Restore and import validate and install the database synchronously on the serving thread; a very large database blocks other requests for that time.
- An asset over 4 GiB cannot be stored in an archive record and is reported as missing by an export.
- Storage writes stage into `save/.tmp/` and `rename` onto the target: atomic replacement, but no fsync, so no power-loss durability. `save/.tmp/` must be on the same filesystem as the namespace folders (one Docker volume at `/app/save`). One server process per `save/` is assumed: startup deletes `save/.tmp/`, and concurrent writes to one key are last-writer-wins. A failed rename (e.g. a Windows file locked by another process) returns 500 and keeps the old file; the server does not retry. The client save adapter retries resource batches with backoff; asset writes are not retried.
- Auth files are still written directly with `writeFileSync` (not atomic).
- `/api/read` opens with `O_NOFOLLOW | O_NONBLOCK` where the OS has them and takes size and bytes from one handle. Namespace folders themselves are trusted: a symlinked `save/assets` is followed. A hostile local process modifying `save/` is out of scope.
- The chat fence orders one client's generation writes; it does not lock a message against another device (a manual write from anywhere closes the fence).
- A batch remove stops at the first filesystem error, such as a missing file. It returns 500, and files deleted before the error stay deleted.
- `/api/set_password` and `/api/crypto` have no auth and no rate limit. The first caller can set the password, and an empty password leaves the server effectively unset.
- `/proxy`, `/proxy2`, and `/hub-proxy` (through `x-risu-node-path`, unauthenticated) forward to arbitrary targets. Only proxy jobs are restricted to local targets.
- JWT validation checks no issuer, audience, `typ`, or `iat`, and a token without `exp` never expires.
