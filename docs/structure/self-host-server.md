# Self-Host Server (Hono on Node), Docker

## Scope

- Owns:
  - `server/src/**`: the Hono self-host server on Node (`@hono/node-server`). Handles static `dist`, auth, disk storage, the resource store and its routes, the reverse proxy, the hub proxy, and streaming proxy jobs over WebSocket.
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

The server is TypeScript run directly by Node's type stripping (`pnpm runserver` = `node server/src/main.ts`, Node `>=24`). There is no build step. Layout: `main.ts`, `app.ts`, and `types.ts` (`AppEnv`) at the root; route modules in `routes/`; the resource data layer in `data/`; shared HTTP helpers in `http/`; tests and their support in `tests/`. The server may import the persisted types in the root `shared/` folder (`persistence.md`); `server/tsconfig.json` includes it, so `pnpm check` strict-checks it. Relative imports use explicit `.ts` extensions, and only erasable syntax is allowed (`server/tsconfig.json` sets `erasableSyntaxOnly`; `pnpm check` runs `tsc -p server/tsconfig.json`).

- `server/src/main.ts`: entry. Reads `PORT` (default 6001) and `TRUST_PROXY`, loads the TLS certificate (`getHttpsOptions`), calls `serve()`, attaches the WebSocket upgrade handler, and starts job GC. `cwd` is the root: `cwd/dist`, `cwd/save`, `cwd/server/ssl/certificate`.
- `server/src/app.ts` `createServerContext({ rootDir, trustProxy, resourceKinds })`: builds the Hono app and owns all state, including the resource store (closed by `dispose`; closing it twice is safe). `resourceKinds` replaces `DEFAULT_RESOURCE_KINDS` (tests use it). Returns `{ app, attachWebSocket, startBackgroundTasks, dispose }`. `app.request()` works for in-process checks, but it has no Node socket, so the client IP is undefined there.
- `server/src/routes/auth.ts` `createAuthStore`: `save/server/password` plus `save/server/known_public_key_hashes.json`, `verifyJwt`, `checkAuth`, `checkProxyAuth`, `isAuthorizedProxyToken`, and the `/api/test_auth|login|crypto|set_password` routes.
- `server/src/routes/storage.ts`: the key-to-file mapping (`STORAGE_NAMESPACES`, `decodeKeyHeader`, `encodeFileName`/`decodeFileName`, `resolveStorageKey`) and `/api/read|write|list|remove`. `registerStorageRoutes` empties `save/.tmp/` at startup.
- `server/src/data/resourceStore.ts` `createResourceStore({ file, kinds })`: typed resource documents in one `node:sqlite` database (`save/data/resources.sqlite`), with revision tokens, conditional writes, `transaction`, `ResourceConflictError`, `ResourceValidationError`, and `isValidResourceId`.
- `server/src/data/kinds.ts`: `ResourceKind<T>` (name, `schemaVersion`, pure `normalize`), `createKindRegistry`, and `DEFAULT_RESOURCE_KINDS` (`root`, `presets`, `modules`, `plugins`, `pluginStorage`, `characters`, identity normalizers until Phase 1 of `docs/plan/PLAN.md`).
- `server/src/routes/resources.ts` `registerResourceRoutes`: `/api/resources/:kind[/:id]`. No client caller yet.
- `server/src/routes/proxy.ts`: `/proxy`, `/proxy2`, `/hub-proxy/*`. `ownBody` re-streams an upstream body and keeps the timeout alive until the body ends.
- `server/src/routes/proxyStreamJobs.ts` `createProxyStreamJobs`: the job map, `sanitizeTargetUrl`, `isLocalNetworkHost`, `requestLocalTargetStream` (Node `http`/`https`), the POST/DELETE routes, the `ws` upgrade handler, and GC.
- `server/src/http/rateLimit.ts` `createRateLimiter`: an in-memory limiter that reproduces the former express-rate-limit v8 setup (see Invariants).
- `server/src/http/clientIp.ts`: `parseTrustProxyEnv`, `compileTrust` (Express semantics), and `getClientIp` (`proxy-addr` over `c.env.incoming`).
- `server/src/http/body.ts` `readJsonBody`: JSON body parsing with Express-like defaults.
- `server/ssl/Generate Certificate.sh|.bat`, `ca.conf`, `server.conf`: generate a local CA and server certificate into `server/ssl/certificate/` (run from `server/ssl/`). `main.ts` uses HTTPS when `server.key`/`server.crt` exist there, relative to `cwd`.
- `Dockerfile`: Node 24, pnpm 10.34.1, multi-stage build of `dist`. Copies `server/` + `shared/` + `dist/` + prod `node_modules`, `EXPOSE 6001`, `CMD pnpm runserver`.
- `server.sh`/`server.bat`: install, build, run. The runtime env exports are commented out.

## Routes

Registration order in `createServerContext`:

1. `onError` (`HTTPException` responses pass through; anything else is a 500 `Internal Server Error`).
2. `bodyLimit` (100 MiB, 413 `{error:"Request body too large"}`).
3. `GET /` and `GET /index.html` (one shared handler).
4. `serveStatic` for every other GET/HEAD.
5. The routes below.

Routing is non-strict (a trailing slash matches).

| Method     | Path                                    | Auth                                                                         | Rate limit     | Purpose                                                                                                                              |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| GET/HEAD   | `dist/*`                                | none                                                                         | none           | built frontend (`@hono/node-server` `serveStatic`: ranges, `Last-Modified`, no ETag)                                                 |
| GET        | `/`, `/index.html`                      | none                                                                         | none           | serves `dist/index.html` with `globalThis.__NODE__ = true` injected after the `<head>` tag                                           |
| GET/POST   | `/proxy`, `/proxy2`                     | `checkProxyAuth` (stored password in `risu-auth`, or a registered ES256 JWT) | 2000/min       | arbitrary reverse proxy (`risu-url`, `risu-header`)                                                                                  |
| GET        | `/hub-proxy/*`                          | none                                                                         | 2000/min       | proxies to `x-risu-node-path` or `https://sv.risuai.xyz`                                                                             |
| POST       | `/proxy-stream-jobs`                    | `checkProxyAuth`                                                             | 2000/min       | creates a local-network streaming job. `sanitizeTargetUrl` allows local/private targets only. Body ≤ 8 MiB base64, ≤ 64 active jobs. |
| DELETE     | `/proxy-stream-jobs/:jobId`             | yes                                                                          | 2000/min       | aborts a job                                                                                                                         |
| WS upgrade | `/proxy-stream-jobs/:jobId/ws`          | `risu-auth` query or header                                                  | none           | event stream (`ProxyJobWsEvent`)                                                                                                     |
| GET        | `/api/test_auth`                        | none                                                                         | 2000/min (own) | returns `unset`, `incorrect`, or `success`                                                                                           |
| POST       | `/api/login`                            | password digest                                                              | 10 per 30 s    | registers a public-key hash                                                                                                          |
| POST       | `/api/crypto`                           | **none**                                                                     | **none**       | SHA-256 of `body.data` (text/plain)                                                                                                  |
| POST       | `/api/set_password`                     | **none**, only works while unset                                             | **none**       | first-run password setup                                                                                                             |
| GET        | `/api/read`, `/api/remove`, `/api/list` | `checkAuth` (JWT)                                                            | 2000/min       | storage. The `file-path` header is the hex UTF-8 key; `remove` takes `$$`-joined hex keys.                                           |
| POST       | `/api/write`                            | `checkAuth`                                                                  | 2000/min       | storage write, raw body bytes                                                                                                        |
| GET        | `/api/resources/:kind`                  | `checkAuth`                                                                  | 2000/min       | `{ items: [{ id, revision, data }] }` in creation order; 404 for an unknown kind                                                     |
| GET        | `/api/resources/:kind/:id`              | `checkAuth`                                                                  | 2000/min       | `{ revision, data }`; 404 when missing, 400 for an invalid id                                                                        |
| PUT        | `/api/resources/:kind/:id`              | `checkAuth`                                                                  | 2000/min       | body `{ baseRevision: string \| null, data }`; returns `{ revision, data }` as stored; 409 `{ error, revision }` on a stale revision |
| DELETE     | `/api/resources/:kind/:id`              | `checkAuth`                                                                  | 2000/min       | `?baseRevision=<token>`; `{ success: true }`; 409 `{ error, revision }` when stale or already gone                                   |

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
2. It calls `/api/test_auth`, then either `/api/set_password` (first run) or `/api/login`.
3. Once logged in, the server knows the key hash, and later requests only send the JWT.

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
- `.tmp/`: staged writes, emptied at startup.
- `data/resources.sqlite` (plus its `-wal` and `-shm` files): the resource store. Table `resources` (`seq` autoincrement, `kind`, `id`, `revision`, `schemaVersion`, `data` JSON text, unique `(kind, id)`) and table `meta` holding the random `epoch`; `PRAGMA user_version` is the layout version (1). The connection runs with `journal_mode=WAL`, `busy_timeout=5000`, and `foreign_keys=ON`. `data/` is not a storage namespace.
- User files, one folder per namespace: a logical key `<namespace>/<name>` lives at `save/<namespace>/<encodeFileName(name)>`, e.g. `database/database.bin`, `database/dbbackup-*.bin`, `assets/<sha>.png`, `remotes/<chaId>.local.bin`.
  - `encodeFileName` keeps `a-z 0-9 . _ -` readable and writes every other UTF-8 byte (uppercase letters, `/`, `%`, spaces, non-ASCII) as `%XX`. It also escapes a trailing dot and the first character of a Windows device name (`con.png` → `%63on.png`). A name whose readable form exceeds 255 bytes is stored as `~<lowercase hex>`; longer than that is rejected.
  - Only one encoding per name is canonical, and canonical names never differ by case alone, so case-insensitive filesystems do not merge keys.
  - The old flat layout (hex file names and `__password` directly in `save/`) is not read and was not migrated.

Process memory, inside the `createServerContext` closure:

- `password` and the known key hashes.
- The proxy stream job map.
- Rate-limit counters.

## Coupling

- Server dependencies:
  - `hono` and `@hono/node-server`.
  - `ws`, for the upgrade handler.
  - `proxy-addr` and `ipaddr.js`.
  - Node `crypto`/`fs`/`http`/`https`/`net`/`sqlite`.
  - All of the above are prod dependencies because the Docker runtime stage installs `--prod`.
- Client dependencies that use this server: `NodeStorage`, `AutoStorage`, `globalApi` proxy code, `characterCards.hubURL` (`/hub-proxy`), `util.ts` DPoP storage.

## Invariants

- Storage routes never use a raw path. `decodeKeyHeader` requires even-length hex and valid UTF-8 (verified by an exact byte round trip), then `resolveStorageKey` requires a namespace from `STORAGE_NAMESPACES` (`database`, `assets`, `remotes`) and encodes the whole rest of the key, `/` included, into one file name. Only these folders are reachable; `save/server/` and `save/.tmp/` are not.
- Unsupported keys: malformed hex/UTF-8 is 400 `Invaild Path` on every route. A well-formed key with no storage location (other namespace, empty or too-long name) reads as missing (empty 200, no disk access), because the client reads whatever paths an old database stored; `write` and `remove` reject it with 400.
- `/api/list` returns only regular files whose names are canonical `encodeFileName` output, so every listed key reads back the same file. Other entries (subfolders, symlinks, noncanonical file names) are ignored.
- Keep the logical keys and the hex wire encoding; the client depends on both. The mapping to file names must stay reversible and injective.
- Keep these unchanged:
  - the `__NODE__` injection;
  - the `risu-*` header names and `x-risu-node-path`;
  - status codes and JSON error bodies, including the `Invaild Path` typo (one deliberate change: a `/api/read` filesystem error other than a missing file, symlink, or non-regular file is now a 500 instead of an empty 200);
  - the 100 MiB body limit.
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
- Resource writes normalize inside the store: `put` runs the kind's `normalize` once and stores its JSON result. The store is built with the kind registry and every method refuses a kind object the registry does not hold, so no caller can swap in another normalizer. A value is stored as `JSON.stringify` produces it (`toJSON` applies, `undefined` fields drop, Dates become strings, `-0` becomes `0`), and `put` and later reads return that stored form. `put` refuses, with `ResourceValidationError` (400), data whose JSON form would turn a non-finite number into `null` (`1e400` parses to `Infinity`), data `JSON.stringify` cannot serialize (a bigint, a cycle, a throwing getter, runaway nesting), and a JSON form nested deeper than 256 levels. `transaction(fn)` is one synchronous `BEGIN IMMEDIATE`; a throw, or any conflict inside it even if `fn` caught it, rolls back every write. A body whose return type can be a promise does not type-check (`TransactionBody`, best-effort: a body returning `any` passes, and an overloaded function reference is judged by its last overload, so wrap it in a zero-argument arrow), and at runtime a returned promise or thenable rolls back and throws. An `AsyncLocalStorage` scope follows the work the body starts through awaits, promise continuations, and timers: once the body returns, a write from that work throws, so it cannot autocommit after a rollback. Callbacks the body registers on an event emitter do not carry the scope and are not covered. Never await inside a transaction.
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
- Add a resource kind: add a `ResourceKind` to `DEFAULT_RESOURCE_KINDS` with a pure `normalize` (throw `ResourceValidationError` to reject) and a `schemaVersion`; the routes pick it up.
- Change packaging: `Dockerfile`, the README Docker steps, and `package.json` `runserver` together. Any new root folder the server imports at runtime (like `shared/`) needs a `COPY` in the `runtime` stage.

## Tests

- Server (`// @vitest-environment node`, type-checked by `pnpm check` through `server/tsconfig.json`):
  - `server/src/tests/app.test.ts`: `__NODE__` injection (`/` and `/index.html`), auth flow and JWT failure bodies, JSON rules, login limiter, storage layout (including `save/data/`) and key mapping, batch remove.
  - `server/src/tests/proxy.test.ts`: proxy auth, raw bodies, header filtering, SSE, timeout, HEAD, hub proxy.
  - `server/src/tests/proxyStreamJobs.test.ts`: target allowlist, job validation, a real `serve()` WebSocket lifecycle, DELETE and `dispose()` closing upstreams.
  - `server/src/tests/testSupport.ts`: temp-root context, ES256 signer, recording upstream.
  - `server/src/tests/resources.test.ts`: resource routes: round trip, stale and duplicate writes (409 with the current revision), envelope and token validation, non-finite and over-deep data, normalizer rejection through the `resourceKinds` seam of `createTestServer`, list order, delete and recreate, unknown kind, invalid id, auth.
  - `server/src/tests/resourceStore.test.ts`: revision tokens (epoch, incarnation, malformed), reopen and idempotent `close`, unregistered kind objects, the stored JSON form and its limits (non-finite numbers, unserializable values including a `Number` box whose conversion hook returns a bigint, 256/257 depth), and `transaction`: commit, rollback, nested, caught conflict, promise and thenable bodies, the ended-scope write rejection, plus the `TransactionBody` compile-time checks (`@ts-expect-error`, checked by the server `tsc`).
  - `server/src/tests/sharedImports.test.ts`: spawns plain `node` to import every `shared/*.ts`, the runtime guard for the `.ts` import convention (type-only imports are erased before Node resolves them; the `nodenext` server `tsc` checks those).
- In-process tests use `createServerContext({ rootDir: <tmp> }).app.request()` (no socket, so the client IP is undefined). Socket-level behavior (client IP, aborts, TLS, WebSocket) needs a real listening server. Call `dispose()` afterwards.
- Client helpers: `src/ts/network/proxyJobWs.test.ts`, `src/ts/network/localNetwork.test.ts`.
- No Docker tests. The Phase 0 check built the image and started it by hand (see the phase file).

## Known Hazards

- `put` validates a value's depth on its parsed JSON form, so an over-deep value is rejected only after it has been fully serialized and parsed. Over HTTP the body is already parsed and capped at 100 MiB; only in-process callers could pass costlier values (getters, `toJSON`).
- The resource store assumes one server process and a local filesystem for `save/data/` (SQLite WAL uses shared memory; network filesystems are unsupported). Restore and backups are not implemented yet (Phase 1 of `docs/plan/PLAN.md`); deleting `save/data/` loses every resource.
- Storage writes stage into `save/.tmp/` and `rename` onto the target: atomic replacement, but no fsync, so no power-loss durability. `save/.tmp/` must be on the same filesystem as the namespace folders (one Docker volume at `/app/save`). One server process per `save/` is assumed: startup deletes `save/.tmp/`, and concurrent writes to one key are last-writer-wins. A failed rename (e.g. a Windows file locked by another process) returns 500 and keeps the old file; the server does not retry. The client does not retry either: `saveDb` clears `changed` before writing and does not restore it on failure, so the unsaved state is written only after the next change (pre-existing client behavior).
- Auth files are still written directly with `writeFileSync` (not atomic).
- `/api/read` opens with `O_NOFOLLOW | O_NONBLOCK` where the OS has them and takes size and bytes from one handle. Namespace folders themselves are trusted: a symlinked `save/assets` is followed. A hostile local process modifying `save/` is out of scope.
- Local backups carry only `.png` assets by basename and restore them under `assets/`; asset names containing `/` do not survive a backup round trip (pre-existing, client side).
- A batch remove stops at the first filesystem error, such as a missing file. It returns 500, and files deleted before the error stay deleted.
- `/api/set_password` and `/api/crypto` have no auth and no rate limit. The first caller can set the password, and an empty password leaves the server effectively unset.
- `/proxy`, `/proxy2`, and `/hub-proxy` (through `x-risu-node-path`, unauthenticated) forward to arbitrary targets. Only proxy jobs are restricted to local targets.
- JWT validation checks no issuer, audience, `typ`, or `iat`, and a token without `exp` never expires.
