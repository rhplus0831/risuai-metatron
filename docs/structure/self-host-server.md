# Self-Host Server (Hono on Node), Docker

## Scope

- Owns:
  - `server/src/*`: the Hono self-host server on Node (`@hono/node-server`). Handles static `dist`, auth, disk storage, the reverse proxy, the hub proxy, and streaming proxy jobs over WebSocket.
  - Local TLS certificates.
  - Docker packaging.
  - The launcher scripts.
  - The client/server contract, seen from the server side.
- Paths: `server/{src/*,tsconfig.json,ssl/*}`, `Dockerfile`, `.dockerignore`, `server.sh`, `server.bat`.
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
- `server.sh`/`server.bat`: install, build, run. The env exports (legal, ads) are commented out.

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
| GET        | `/api/read`, `/api/remove`, `/api/list` | `checkAuth` (JWT)                                                            | 2000/min       | storage. The `file-path` header is hex; `remove` takes `$$`-joined hex keys.                                                         |
| POST       | `/api/write`                            | `checkAuth`                                                                  | 2000/min       | storage write, raw body bytes                                                                                                        |

The three 2000/min rows marked "2000/min" share one limiter; `test_auth` has its own. Login has its own.

## Flows

Boot:

1. `pnpm runserver` runs `node server/src/main.ts`.
2. `createAuthStore` loads `save/__password` and `save/__known_public_key_hashes.json`. It creates `save/` if missing.
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
  - a non-JSON content type or a zero-length body is `{}`;
  - malformed JSON (including whitespace only) or a top-level primitive is 400 `{error:"Invalid JSON body"}`.
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
- Change proxy policy: server `sanitizeTargetUrl`, client `localNetwork.ts` + `fetchNative`.
- Change streaming: `proxyStreamJobs.ts` (`runJob`, `attachWebSocket`, `onConnection`), `ProxyJobWsEvent`, `fetchViaProxyJobWs`, and `proxyJobWs.test.ts`.
- Change packaging: `Dockerfile`, the README Docker steps, and `package.json` `runserver` together.

## Tests

- Server (`// @vitest-environment node`, type-checked by `pnpm check` through `server/tsconfig.json`):
  - `server/src/app.test.ts`: `__NODE__` injection (`/` and `/index.html`), auth flow and JWT failure bodies, JSON rules, login limiter, storage, hex guard, batch remove.
  - `server/src/proxy.test.ts`: proxy auth, raw bodies, header filtering, SSE, timeout, HEAD, hub proxy.
  - `server/src/proxyStreamJobs.test.ts`: target allowlist, job validation, a real `serve()` WebSocket lifecycle, DELETE and `dispose()` closing upstreams.
  - `server/src/testSupport.ts`: temp-root context, ES256 signer, recording upstream.
- In-process tests use `createServerContext({ rootDir: <tmp> }).app.request()` (no socket, so the client IP is undefined). Socket-level behavior (client IP, aborts, TLS, WebSocket) needs a real listening server. Call `dispose()` afterwards.
- Client helpers: `src/ts/network/proxyJobWs.test.ts`, `src/ts/network/localNetwork.test.ts`.
- No Docker tests.

## Known Hazards

- Writes are not atomic: direct `writeFile`, no temp-file rename, no fsync.
- A batch remove stops at the first filesystem error, such as a missing file. It returns 500, and files deleted before the error stay deleted.
- `/api/set_password` and `/api/crypto` have no auth and no rate limit. The first caller can set the password, and an empty password leaves the server effectively unset.
- `/proxy`, `/proxy2`, and `/hub-proxy` (through `x-risu-node-path`, unauthenticated) forward to arbitrary targets. Only proxy jobs are restricted to local targets.
- JWT validation checks no issuer, audience, `typ`, or `iat`, and a token without `exp` never expires.
