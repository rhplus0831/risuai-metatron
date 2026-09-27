# Self-Host Server (Hono on Node), Docker, Edge Proxies

## Scope

- Owns:
  - `server/src/*`: the Hono self-host server on Node (`@hono/node-server`). Handles static `dist`, auth, disk storage, the reverse proxy, the hub proxy, and streaming proxy jobs over WebSocket.
  - Local TLS certificates.
  - Docker packaging.
  - The launcher scripts.
  - The edge proxy functions.
  - The client/server contract, seen from the server side.
- Paths: `server/{src/*,tsconfig.json,ssl/*}`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `server.sh`, `server.bat`, `public/functions/{proxy,proxy2}.js`.
- Client counterparts, owned by other guides:
  - `src/ts/storage/nodeStorage.ts` → `persistence.md`.
  - `globalApi.svelte.ts` `fetchNative`/`fetchViaProxyJobWs` → `global-api.md`.
  - `characterCards.ts` `hubURL` → `characters-modules.md`.

## Files

The server is TypeScript run directly by Node's type stripping (`pnpm runserver` = `node server/src/main.ts`, Node `>=24`). There is no build step. Relative imports use explicit `.ts` extensions, and only erasable syntax is allowed (`server/tsconfig.json` sets `erasableSyntaxOnly`; `pnpm check` runs `tsc -p server/tsconfig.json`).

- `server/src/main.ts`: entry. Reads `PORT` (default 6001) and `TRUST_PROXY`, loads the TLS certificate (`getHttpsOptions`), calls `serve()`, attaches the WebSocket upgrade handler, and starts job GC. `cwd` is the root: `cwd/dist`, `cwd/save`, `cwd/server/ssl/certificate`.
- `server/src/app.ts` `createServerContext({ rootDir, trustProxy })`: builds the Hono app and owns all state. Returns `{ app, attachWebSocket, startBackgroundTasks, dispose }`. `app.request()` works for in-process checks, but it has no Node socket, so the client IP is undefined there.
- `server/src/auth.ts` `createAuthStore`: `__password` plus known key hashes, `verifyJwt`, `checkAuth`, `checkProxyAuth`, `isAuthorizedProxyToken`, and the `/api/test_auth|login|crypto|set_password` routes.
- `server/src/storage.ts`: `isHex` and `/api/read|write|list|remove`.
- `server/src/proxy.ts`: `/proxy`, `/proxy2`, `/hub-proxy/*`. `ownBody` re-streams an upstream body and keeps the timeout alive until the body ends.
- `server/src/proxyStreamJobs.ts` `createProxyStreamJobs`: the job map, `sanitizeTargetUrl`, `isLocalNetworkHost`, `requestLocalTargetStream` (Node `http`/`https`), the POST/DELETE routes, the `ws` upgrade handler, and GC.
- `server/src/rateLimit.ts` `createRateLimiter`: an in-memory limiter that reproduces the former express-rate-limit v8 setup (see Invariants).
- `server/src/clientIp.ts`: `parseTrustProxyEnv`, `compileTrust` (Express semantics), and `getClientIp` (`proxy-addr` over `c.env.incoming`).
- `server/src/body.ts` `readJsonBody`: JSON body parsing with Express-like defaults.
- `server/ssl/Generate Certificate.sh|.bat`, `ca.conf`, `server.conf`: generate a local CA and server certificate into `server/ssl/certificate/` (run from `server/ssl/`). `main.ts` uses HTTPS when `server.key`/`server.crt` exist there, relative to `cwd`.
- `Dockerfile`: Node 24, pnpm 10.34.1, multi-stage build of `dist`. Copies `server/` + `dist/` + prod `node_modules`, `EXPOSE 6001`, `CMD pnpm runserver`.
- `docker-compose.yml`: GHCR image, `6001:6001`, volume `risuai-save:/app/save`.
- `server.sh`/`server.bat`: install, build, run. The env exports (legal, ads) are commented out.
- `public/functions/proxy.js`, `proxy2.js`: edge `onRequest` open proxies with no auth or allowlist. `proxy2` prefers the `risu-url` header.

## Routes

Registration order in `createServerContext`:

1. `onError` (`HTTPException` responses pass through; anything else is a 500 `Internal Server Error`).
2. `bodyLimit` (100 MiB, 413 `{error:"Request body too large"}`).
3. `GET /`.
4. `serveStatic` for every other GET/HEAD.
5. The routes below.

Routing is non-strict (a trailing slash matches).

| Method     | Path                                    | Auth                                                                         | Rate limit     | Purpose                                                                                                                              |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| GET/HEAD   | `dist/*`                                | none                                                                         | none           | built frontend (`@hono/node-server` `serveStatic`: ranges, `Last-Modified`, no ETag)                                                 |
| GET        | `/`                                     | none                                                                         | none           | serves `dist/index.html` with `globalThis.__NODE__ = true` injected after the `<head>` tag                                           |
| GET/POST   | `/proxy`, `/proxy2`                     | `checkProxyAuth` (stored password in `risu-auth`, or a registered ES256 JWT) | 2000/min       | arbitrary reverse proxy (`risu-url`, `risu-header`)                                                                                  |
| GET        | `/hub-proxy/*`                          | none                                                                         | 2000/min       | proxies to `x-risu-node-path` or `https://sv.risuai.xyz`                                                                             |
| POST       | `/proxy-stream-jobs`                    | `checkProxyAuth`                                                             | 2000/min       | creates a local-network streaming job. `sanitizeTargetUrl` allows local/private targets only. Body ≤ 8 MiB base64, ≤ 64 active jobs. |
| DELETE     | `/proxy-stream-jobs/:jobId`             | yes                                                                          | 2000/min       | aborts a job                                                                                                                         |
| WS upgrade | `/proxy-stream-jobs/:jobId/ws`          | `risu-auth` query or header                                                  | none           | event stream (`ProxyJobWsEvent`)                                                                                                     |
| GET        | `/api/test_auth`                        | none                                                                         | 2000/min (own) | returns `unset`, `incorrect`, or `success`                                                                                           |
| POST       | `/api/login`                            | password digest                                                              | 10 per 30 s    | registers a public-key hash                                                                                                          |
| POST       | `/api/crypto`                           | **none**                                                                     | **none**       | SHA-256 of `body.data` (text/plain)                                                                                                  |
| POST       | `/api/set_password`                     | **none**, only works while unset                                             | **none**       | first-run password setup                                                                                                             |
| GET        | `/api/read`, `/api/remove`, `/api/list` | `checkAuth` (JWT)                                                            | 2000/min       | storage. The `file-path` header is hex; `remove` takes `$$`-joined hex keys.                                                         |
| POST       | `/api/write`                            | `checkAuth`                                                                  | 2000/min       | storage write, raw body bytes                                                                                                        |

The three 2000/min rows marked "2000/min" share one limiter; `test_auth` has its own. Login has its own.

## Flows

Boot:

1. `pnpm runserver` runs `node server/src/main.ts`.
2. `createAuthStore` loads `save/__password` and `save/__known_public_key_hashes.json`. It creates `save/` if missing.
3. `serve()` listens on HTTPS or HTTP. A listen error (e.g. `EADDRINUSE`) logs and exits 1.

Client detection:

1. `GET /` injects `__NODE__`, which makes `isNodeServer` true in the client.
2. `AutoStorage` then picks `NodeStorage`.

Auth:

1. `NodeStorage.checkAuth` creates an ES256 JWT (P-256, 5-minute expiry, public JWK). The key pair is kept in IndexedDB `DPoPDB`, entry `node`.
2. It calls `/api/test_auth`, then either `/api/set_password` (first run) or `/api/login`.
3. Once logged in, the server knows the key hash, and later requests only send the JWT.

Proxying:

- The client sends `risu-url` and `risu-header` (encoded JSON) to same-origin `/proxy2`.
- The request body is forwarded as raw bytes.
- Hop-by-hop headers, `content-length`, and `risu-auth` are never forwarded upstream.
- Response headers drop CSP, `clear-site-data`, `cache-control`, `content-encoding`, `content-length`, and `transfer-encoding`.
- `risu-timeout-ms` covers the whole exchange:
  - Before upstream headers it returns 504 `{error}`.
  - Mid-stream it ends the response cleanly.
- A client disconnect aborts the upstream fetch.
- Node local-network streaming uses the job and WebSocket protocol with events `job_accepted`, `upstream_headers`, `chunk` (base64), `error`, `done`, and `ping`. Heartbeat is 5–60 s. Jobs have a 30 s done-grace period.

## State

Disk, under `save/`:

- `__password`: the client-side SHA-256 digest via `/api/crypto`.
- `__known_public_key_hashes.json`.
- User files, named by their hex-encoded logical key: `database/database.bin`, `database/dbbackup-*.bin`, `assets/*`, `remotes/*`. Legacy `coldstorage/*` files from removed cold storage may remain but are no longer read.

Process memory, inside the `createServerContext` closure:

- `password` and the known key hashes.
- The proxy stream job map.
- Rate-limit counters.

## Coupling

- Server dependencies:
  - `hono` and `@hono/node-server`.
  - `ws`, for the upgrade handler.
  - `proxy-addr` and `ipaddr.js`.
  - Node `crypto`/`fs`/`http`/`https`/`net`.
  - All of the above are prod dependencies because the Docker runtime stage installs `--prod`.
- Client dependencies that use this server: `NodeStorage`, `AutoStorage`, `globalApi` proxy code, `characterCards.hubURL` (`/hub-proxy`), `util.ts` DPoP storage.

## Invariants

- Hex file names are the path-traversal guard. `isHex` only lets through hex strings plus `__password`. Never accept raw paths.
- Keep the logical keys and the hex encoding. Existing `save/` directories must keep working.
- Keep these unchanged:
  - the `__NODE__` injection;
  - the `risu-*` header names and `x-risu-node-path`;
  - status codes and JSON error bodies, including the `Invaild Path` typo;
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
  - a non-JSON content type or an empty body is `{}`;
  - malformed JSON or a top-level primitive is 400 `{error:"Invalid JSON body"}`.
- Streaming job protocol: the event names, base64 chunks, authentication on the WebSocket upgrade, and timeouts must all match `src/ts/network/proxyJobWs.ts` and `fetchViaProxyJobWs`.
- The WebSocket upgrade handler is `ws` attached directly to the server returned by `serve()`. Do not also pass `websocket` to `serve()` or add `@hono/node-ws`: two upgrade listeners conflict.
- Docker persistence depends on `/app/save`. Removing the volume loses the password, registered keys, and all data.

## Recipes

- Add a storage operation:
  - Add a route in `storage.ts` with `auth.checkAuth`, the shared limiter, and hex validation.
  - Add the matching `NodeStorage` method.
- Change auth:
  - Client: `NodeStorage.createAuth`/`checkAuth`/`digestPassword`.
  - Server: `auth.ts` (`verifyJwt`, the `/api/login` route).
  - Verify first run, restart, token expiry, and unknown keys.
- Change proxy policy: server `sanitizeTargetUrl`, client `localNetwork.ts` + `fetchNative`, and the edge `proxy*.js`.
- Change streaming: `proxyStreamJobs.ts` (`runJob`, `attachWebSocket`, `onConnection`), `ProxyJobWsEvent`, `fetchViaProxyJobWs`, and `proxyJobWs.test.ts`.
- Change packaging: `Dockerfile`, `docker-compose.yml`, and `package.json` `runserver` together.

## Tests

- Client helpers only: `src/ts/network/proxyJobWs.test.ts`, `src/ts/network/localNetwork.test.ts`.
- Server route tests can use `createServerContext({ rootDir: <tmp> }).app.request()` (Vitest `// @vitest-environment node`).
  - Socket-level behavior (client IP, aborts, TLS, WebSocket) needs a real listening server.
  - Call `dispose()` afterwards.
- No Docker tests.

## Known Hazards

- Writes are not atomic: direct `writeFile`, no temp-file rename, no fsync.
- A batch remove stops at the first filesystem error, such as a missing file. It returns 500, and files deleted before the error stay deleted.
- `/api/set_password` and `/api/crypto` have no auth and no rate limit. The first caller can set the password, and an empty password leaves the server effectively unset.
- `/proxy`, `/proxy2`, `/hub-proxy` (through `x-risu-node-path`, unauthenticated), and the edge proxies forward to arbitrary targets. Only proxy jobs are restricted to local targets.
- JWT validation checks no issuer, audience, `typ`, or `iat`, and a token without `exp` never expires.
