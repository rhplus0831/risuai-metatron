# Self-Host Server (Node/Express), Hono Skeleton, Docker, Edge Proxies

## Scope
- Owns:
  - `server/node/server.cjs`: the Express self-host server. Handles static `dist`, auth, disk storage, the reverse proxy, the hub proxy, streaming proxy jobs over WebSocket, and OAuth.
  - Local TLS certificates.
  - The `server/hono` skeleton.
  - Docker packaging.
  - The launcher scripts.
  - The edge proxy functions.
  - The client/server contract, seen from the server side.
- Paths: `server/node/{server.cjs,readme.md,ssl/*}`, `server/hono/**`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `server.sh`, `server.bat`, `public/functions/{proxy,proxy2}.js`.
- Client counterparts, owned by other guides:
  - `src/ts/storage/nodeStorage.ts` → `persistence.md`.
  - `globalApi.svelte.ts` `fetchNative`/`fetchViaProxyJobWs` → `global-api.md`.
  - `characterCards.ts` `hubURL` → `characters-modules.md`.

## Files
- `server/node/server.cjs`:
  - Key identifiers: `app`, `savePath` (= `cwd/save`), `checkAuth`, `checkProxyAuth`, `isAuthorizedJwtHeader`, `reverseProxyFunc`, `reverseProxyFunc_get`, `hubProxyFunc`, `sanitizeTargetUrl`, `isLocalNetworkHost`, `normalizeForwardHeaders`, `createProxyStreamJob`, `runProxyStreamJob`, `setupProxyStreamWebSocket`, `getHttpsOptions`, `startServer`.
  - Environment: `PORT` (default 6001), `TRUST_PROXY`.
- `server/node/ssl/Generate Certificate.sh|.bat`, `ca.conf`, `server.conf`: generate a local CA and server certificate. `startServer` uses HTTPS when `server.key`/`server.crt` exist.
- `server/hono/*`:
  - `src/app/index.ts` is only CSRF middleware plus `GET /` → "Hello Hono".
  - Adapters: `node.ts` (port 3000), `bun.ts`, `cf.ts`.
  - `package.json` `dev` and `wrangler.jsonc` point to missing entry files.
  - It does not implement any Node route.
- `Dockerfile`: Node 24, pnpm 10.34.1, multi-stage build of `dist`, copies `server/` + `dist/`, `EXPOSE 6001`, `CMD pnpm runserver`.
- `docker-compose.yml`: GHCR image, `6001:6001`, volume `risuai-save:/app/save`.
- `server.sh`/`server.bat`: install, build, run. The env exports (legal, ads) are commented out.
- `public/functions/proxy.js`, `proxy2.js`: edge `onRequest` open proxies with no auth or allowlist. `proxy2` prefers the `risu-url` header.

## Routes (`server.cjs`)

| Method | Path | Auth | Rate limit | Purpose |
|---|---|---|---|---|
| static | `dist/*` | none | none | built frontend (`express.static`, `index:false`) |
| GET | `/` | none | none | serves `dist/index.html` with `globalThis.__NODE__ = true` injected |
| GET/POST | `/proxy`, `/proxy2` | `checkProxyAuth` (stored password in `risu-auth`, or a registered ES256 JWT) | 2000/min | arbitrary reverse proxy (`risu-url`, `risu-header`) |
| GET | `/hub-proxy/*` | none | 2000/min | proxies to `x-risu-node-path` or `https://sv.risuai.xyz` |
| POST | `/proxy-stream-jobs` | `checkProxyAuth` | 2000/min | creates a local-network streaming job. `sanitizeTargetUrl` allows local/private targets only. Body ≤ 8 MiB base64, ≤ 64 active jobs. |
| DELETE | `/proxy-stream-jobs/:jobId` | yes | 2000/min | aborts a job |
| WS upgrade | `/proxy-stream-jobs/:jobId/ws` | `risu-auth` query or header | none | event stream (`ProxyJobWsEvent`) |
| GET | `/api/test_auth` | none | auth limiter | returns `unset`, `incorrect`, or `success` |
| POST | `/api/login` | password digest | 10 per 30 s | registers a public-key hash |
| POST | `/api/crypto` | **none** | **none** | SHA-256 of `body.data` |
| POST | `/api/set_password` | **none**, only works while unset | **none** | first-run password setup |
| GET | `/api/read`, `/api/remove`, `/api/list` | `checkAuth` (JWT) | 2000/min | storage. The `file-path` header is hex; `remove` splits it on `$$`. |
| POST | `/api/write` | `checkAuth` | 2000/min | storage write, binary body |

## Flows
Boot:
1. `pnpm runserver` runs `server.cjs`.
2. The server loads `save/__password` and `save/__known_public_key_hashes.json`.
3. `startServer` listens on HTTPS or HTTP.

Client detection:
1. `GET /` injects `__NODE__`, which makes `isNodeServer` true in the client.
2. `AutoStorage` then picks `NodeStorage`.

Auth:
1. `NodeStorage.checkAuth` creates an ES256 JWT (P-256, 5-minute expiry, public JWK). The key pair is kept in IndexedDB `DPoPDB`, entry `node`.
2. It calls `/api/test_auth`, then either `/api/set_password` (first run) or `/api/login`.
3. Once logged in, the server knows the key hash, and later requests only send the JWT.

Proxying:
- The client sends `risu-url` and `risu-header` (encoded JSON) to same-origin `/proxy2`.
- Node local-network streaming uses the job and WebSocket protocol with events `job_accepted`, `upstream_headers`, `chunk` (base64), `error`, `done`, and `ping`. Heartbeat is 5–60 s. Jobs have a 30 s done-grace period.

## State
Disk, under `save/`:
- `__password`: the client-side SHA-256 digest via `/api/crypto`.
- `__known_public_key_hashes.json`.
- User files, named by their hex-encoded logical key: `database/database.bin`, `database/dbbackup-*.bin`, `assets/*`, `remotes/*`. Legacy `coldstorage/*` files from removed cold storage may remain but are no longer read.

Process memory: `password`, `knownPublicKeysHashes`, `proxyStreamJobs` (a Map).

## Coupling
- Server dependencies: Express, `express-rate-limit`, `ws`, `node-html-parser`, Node `crypto`/`fs`/`http`/`https`.
- Client dependencies that use this server: `NodeStorage`, `AutoStorage`, `globalApi` proxy code, `characterCards.hubURL` (`/hub-proxy`), `util.ts` DPoP storage.

## Invariants
- Hex file names are the path-traversal guard. `isHex` only lets through hex strings plus `__password`. Never accept raw paths.
- Keep the logical keys and the hex encoding. Existing `save/` directories must keep working.
- Keep the `__NODE__` injection, the `risu-*` header names, `x-risu-node-path`, status codes and response bodies, binary body handling (limit 100 MB), and the rate-limit thresholds.
- Streaming job protocol: the event names, base64 chunks, authentication on the WebSocket upgrade, and timeouts must all match `src/ts/network/proxyJobWs.ts` and `fetchViaProxyJobWs`.
- Docker persistence depends on `/app/save`. Removing the volume loses the password, registered keys, and all data.

### Migration checklist (Express → Fastify/Hono/...)
Preserve all of the following:
- every route and method in the table above,
- the static `dist` serving plus the `/` injection,
- the binary, JSON, and text body parsers,
- the hex `file-path` protocol,
- ES256 JWT verification against the known key hashes,
- the proxy auth (stored password or JWT),
- the `sanitizeTargetUrl` policy for jobs,
- the WebSocket upgrade path and its auth,
- the job limits, heartbeat, and GC interval,
- the OAuth callback paths,
- `PORT`/`TRUST_PROXY`,
- the TLS certificate fallback,
- the `/app/save` mount.

Also update `package.json` `runserver`, `Dockerfile`, `server.sh`, and `server.bat`.

## Recipes
- Add a storage operation: add a route next to `/api/read|write` with `checkAuth`, `authenticatedRouteLimiter`, and hex validation, plus the matching `NodeStorage` method.
- Change auth: `NodeStorage.createAuth`/`checkAuth`/`digestPassword`, and on the server `checkAuth`/`isAuthorizedJwtHeader`/`/api/login`. Verify first run, restart, token expiry, and unknown keys.
- Change proxy policy: server `sanitizeTargetUrl`, client `localNetwork.ts` + `fetchNative`, and the edge `proxy*.js`.
- Change streaming: `createProxyStreamJob`, `runProxyStreamJob`, `setupProxyStreamWebSocket`, `ProxyJobWsEvent`, `fetchViaProxyJobWs`, and `proxyJobWs.test.ts`.
- Change packaging: `Dockerfile`, `docker-compose.yml`, and `package.json` `runserver` together.

## Tests
- Client helpers only: `src/ts/network/proxyJobWs.test.ts`, `src/ts/network/localNetwork.test.ts`.
- No server route, auth, or storage integration tests. No Docker or Hono tests.

## Known Hazards
- Batch remove is broken:
  - The client hex-encodes the `$$`-joined list.
  - The server splits the hex string on `$$`, which never matches.
  - Fix both sides together and add a test.
- Writes are not atomic: direct `writeFile`, no temp-file rename, no fsync.
- `/api/set_password` and `/api/crypto` have no auth and no rate limit. The first caller can set the password, and an empty password leaves the server effectively unset.
- `/proxy`, `/proxy2`, and the edge proxies forward to arbitrary targets. Only proxy jobs are restricted to local targets.
- The server `isLocalNetworkHost` rejects bare single-label hosts, which the client accepts.
- JWT validation checks no issuer, audience, `typ`, or `iat`.
