# Build, Service Worker, Release

## Scope

- Owns package/build config, the `dev:agent` / `dev:human` runner, documentation checks, the PWA worker and manifest,
  the userscript bridge, release identifiers, and repo dotfiles.
- Not here:
  - Test commands, Vitest/Playwright, and browser checks → [test-harness](test-harness.md).
  - `globalApi.svelte.ts` `fetchNative` → [network-jobs](network-jobs.md).
  - Server process, routes, and Docker → [self-host-server](self-host-server.md).

## Files

### Relevant `package.json` scripts

`package.json` is the script inventory; as JSON it holds no comments, so the roles are here. Test commands and
`check:tests` belong to [test-harness](test-harness.md#recipes).

| Script                             | Use                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `dev`                              | Vite only; requires a running `server`.                                                       |
| `build`                            | Vite with source maps, then `util/compressDist.mjs`.                                          |
| `check`                            | `svelte-check` (client), then server `tsc` (cache in `node_modules/.cache/tsc/`).             |
| `check:changed` / `format:changed` | `util/changedChecks.mjs` `types` / `format`; see [Changed-file checks](#changed-file-checks). |
| `check:docs` / `docs:*`            | See [Documentation check](#documentation-check).                                              |
| `server`                           | Node runs `server/src/main.ts` with type stripping.                                           |
| `dev:agent` / `dev:human`          | Agent or human full stack; see [Dev runner](#dev-runner).                                     |
| `format` / `format:check`          | Repository-wide Prettier; `format:check` caches in `node_modules/.cache/prettier/`.           |

### Changed-file checks

- `util/changedChecks.mjs` (`format`, `types`, `--base <ref>`, `isInert`, `ownersLine`): the local checks narrowed to
  the paths git says changed against the merge base with `origin/dev`. Its header defines the changed set and when
  `types` skips a program; `types` never narrows a program to the changed files, and its first line names the guides
  owning the changed paths and the unowned source paths.

### Documentation check

- `util/docsBudget.mjs` (`pnpm check:docs`): plain Node over `STRUCTURE.md` and the guides, one `path:line rule message`
  per finding; its header defines each rule. Failing rules: `ceiling`, `leaf`, `item`, `paren-depth`, `sections`,
  `hazards`, `unresolved-link`, `self-link`, `label`, `missing-path`, `ownership`, and `tree`, the total over
  `TREE_BYTES_RATCHET` (a trim lowers the constant to within 1,000 bytes of the new total). The budgets and targets are
  the [README](README.md)'s.
- `near` does not fail: a file or heading over its target, with the bytes left. `--report` prints the sizes and every
  finding and exits 0; use plain `pnpm check:docs` as the gate.
- Not validated: identifiers in code spans, and a path without a `/` (`package.json`, `vitest.*`). Confirm them with
  targeted `rg` searches; the link rule checks only relative Markdown destinations and heading anchors.
- The guide tools; each header comment holds its contract:
  - `pnpm docs:read <guide> [heading]` (`util/docsRead.mjs`): a guide's headings with their bytes, or one section.
  - `pnpm docs:owner <path>...` (`util/docsOwner.mjs`): each path's owning guide; exit 1 on an unowned one.
  - `pnpm docs:contracts <file-or-dir>...` (`util/docsContracts.mjs`): each export with the `/** */` comment above it.
  - `pnpm docs:ledger <guide> [--base <ref>] [--strict]` (`util/docsLedger.mjs`): the base's `Files` and `Flows`
    identifiers that neither the guide nor a file it names (`--strict`: no glob) holds; exit 1 on any.
  - `pnpm docs:reads [--out <file>] [<dir>...]` (`util/guideReads.mjs`): guide reads counted over local session
    transcripts, for a one-off `docs/audit/guide-reads-<date>.md`; not a gate.

### Config files

- `vite.config.ts`: the client build and the dev server (port 5174, `strictPort`, proxy to `RISU_DEV_SERVER`, `cacheDir`
  from `RISU_VITE_CACHE_DIR`). Look up `risu-node-flag` (dev only: `globalThis.__NODE__`), `risu-build-info` (build
  only: `dist/build-info.json`), and `define` (`__RISU_BUILD__`, read through `src/ts/buildInfo.ts`). Besides Svelte,
  `@tailwindcss/vite`, and `vite-plugin-wasm`, builds use `@rollup/plugin-strip`, `build.target`
  `baseline-widely-available`, `build.minify` `oxc`, and no `manualChunks`; `envPrefix` is Vite's default (`VITE_`).
- `server/src/buildInfo.ts` `resolveBuildInfo`: `RISU_BUILD_COMMIT`, `RISU_BUILD_DATE`, `RISU_BUILD_DIRTY` give the
  build id without git, as the `Dockerfile` build arguments do; otherwise git. The id's shape is in [State](#state).
- `util/compressDist.mjs`: after Vite, writes the smaller `.br` and `.gz` siblings into `dist/`; its extensions are
  `STATIC_COMPRESSIBLE_EXTENSIONS` from `server/src/http/staticCache.ts`, which serves them, and its header holds the
  size and quality rules.
- These are JSON, so their facts stay here:
  - `tsconfig.json`: includes `src/**/*`, `shared/**/*.ts`, and `public/sw.js`. `noEmit: true` and
    `allowImportingTsExtensions: true`: Vite builds the client and Node runs the server, so `tsc` only type-checks, and
    imports of `shared/` use explicit `.ts` extensions.
  - `server/tsconfig.json`: strict, `erasableSyntaxOnly`, `lib: es2023` without DOM; includes `src/**/*.ts` and
    `../shared/**/*.ts`, so `pnpm check` strict-checks the shared persisted types.
  - `tsconfig.node.json` covers the Vite config only and is outside `pnpm check`; see [Issues](#issues).
  - `.prettierrc.json`: 4-space indent, double quotes, semicolons, width 120, 2-space for JSON/YAML/Markdown,
    `prettier-plugin-svelte`, `proseWrap: "always"` for `STRUCTURE.md` and `docs/structure/`.
- `.prettierignore` (its comments give the reasons): `.ignore`'s payloads, all of `public/` (so `public/sw.js` keeps its
  own style), lockfiles, snapshots, `dist/`, `.claude/worktrees/`, and `src/ts/plugins/apiV3/risuai.d.ts`.

### Dev runner

- `util/agentDev.mjs` (`pnpm dev:agent` / `pnpm dev:human`): the server (`node --watch server/src/main.ts`) and Vite as
  children, Vite's proxy pointed at that server. Its header holds the modes, defaults, and overrides; look up
  `spawnManaged` and `stopGroup` (process groups and the stop), `assertPortFree` and `waitForListener` (ports and the
  readiness wait), `acquireSandboxLock` (`save-agent.lock`), and the `readListenConfig` call (the server's own rules,
  `server/src/listenConfig.ts`, before anything starts).
- Modes: `agent` is server 6419, Vite 6418, `RISU_AGENT_DEV_AUTH_BYPASS=TRUE` (the server refuses it off loopback), Vite
  cache `node_modules/.vite-agent`, storage `save-agent/`; `human` is server 6001, Vite 5174, the normal login, `save/`.
  Both can run at once; `RISU_SAVE_DIR` replaces either storage as it is, with no sandbox and no lock.
- `util/agentDevHost.mjs` `resolveAgentDevHost`: both modes bind to `127.0.0.1`, a secure context, which the login
  (`crypto.subtle`) and the service worker need; `RISU_AGENT_DEV_HOST` binds elsewhere, `tailscale` to this machine's
  Tailscale IPv4 only.
- `util/agentDataSandbox.mjs` `prepareAgentDataSandbox` (`RISU_AGENT_DATA_MODE`: `clone`, `keep`, `fresh`): builds
  `save-agent/` from `save/` in `.save-agent.staging-*` and swaps it in; its comments list what a clone copies and
  leaves behind (`server/` secrets among them).
- Test command environment and agent restrictions: [human gate](test-harness.md#human-gate).

### Analysis scripts

- `util/heap/snapshot.mjs` (`summarize`, `diffSnapshots`, `retainers`, `dominators`, `heapReport`): reads a
  `.heapsnapshot` larger than V8's maximum string; `util/heap/analyze.mjs` is its command line. Neither prints string
  content or a property key unless asked, so user snapshots stay local data.
- `util/upstream/checkBinCompat.mjs` (manual, not in `pnpm test`): runs upstream RisuAI's own `.bin` decoder and boot
  defaults on this server's output, `--target legacy` (the default) or `--target current`, and `--bin <file>` on an
  existing export. Its header holds the usage, the environment (`RISU_UPSTREAM_DIR`, `RISU_UPSTREAM_MSGPACKR`,
  `RISU_UPSTREAM_FFLATE`), the checks, and the exit codes. Metatron's export is the legacy format, which both targets
  read. Use trusted local files: upstream's decoder runs in this process.
- `util/upstream/upstreamHarness.mjs` (`UPSTREAM_TARGETS`, the `REAL`, `EXTRACT`, and `OVERRIDES` tiers) loads one
  target per process, lists what neither target runs, and holds each target's approved stub uses.

### Service worker and PWA

- There is no mobile (Capacitor) build. Installation is only through the PWA manifest.
- `public/manifest.json` (JSON, so here): `file_handlers` for `.charx`, `.risup`, `.risum` go through `launchQueue` to
  `characterURLImport`; `share_target` posts multipart form data to the worker's `/sw/share` with the `character`
  (`.charx`), `preset` (`.risup`), and `module` (`.risum`) file entries. An already installed app keeps the old
  `/receive-files/` action until the browser refreshes the manifest.
- `public/sw.js`: the hand-written, unbundled worker. Its header holds the routes (`/sw/check`, `/sw/img/<hex>`,
  `/sw/register`, `/sw/init`, `/sw/share`), Cache Storage `risuCache`, the takeover and activation cleanup, and the
  direct-asset gate. Look up `fetchAsset`, `getAssetAuth`, `signAssetAuth`, `readAssetKeyPair` (signed asset loads),
  `getSource`, `registerCache`, `checkCache` (the cache fallback), and `showPushNow`, `windowState`,
  `appendPushRecords`, `openFromNotification` (Web Push).
- `util/risuUserscript.user.js`: exposes `GM_fetch` as `unsafeWindow.userScriptFetch`, which `globalFetch` uses when
  present, after its local-network and plain-fetch routes.

## Flows

### Production

`pnpm build` runs Vite, then `util/compressDist.mjs` writes smaller `.br` and `.gz` siblings into `dist/`. The Hono
self-host server (`pnpm run server`, `server/src/`) negotiates those siblings for app files while keeping HTML and Range
requests as identity ([static routes](self-host-server.md#routes)). Docker runs the same build and copies `dist/` with
its siblings into the runtime image. Served any other way (static hosting), the client shows the `NodeServerRequired`
notice. There is no desktop build.

### Development

`pnpm run server` plus `pnpm dev`, or `pnpm dev:agent` for both. Vite proxies `/api`, `/proxy`, `/proxy2`, and
`/hub-proxy` (with WebSockets) to the server (`RISU_DEV_SERVER`, default `http://localhost:6001`); the dev caveats are
in [self-host-server](self-host-server.md).

### CI

- GitHub Actions runs `.github/workflows/ci.yml`, one job, `check`, on pushes to `metatron` and `main` and on pull
  requests that target them; a newer run for the same ref cancels the older one. It sets up Node 24, runs
  `corepack enable` (so `pnpm` is the `packageManager` version), and caches the pnpm store at `$RUNNER_TEMP/pnpm-store`
  (`PNPM_STORE_DIR`), keyed on `pnpm-lock.yaml`.
- It then runs `util/ci/check.sh`, whose header lists the steps: `pnpm install --frozen-lockfile`, `pnpm check`,
  `pnpm format:check`, `pnpm check:tests`, `pnpm check:docs`, `CI=1 pnpm test` (no `slow` tag), and `pnpm build`.
  `pnpm test:slow` and `pnpm test:e2e` are not in CI.
- The job uses no secrets and no `save/` data. A person can run the same script locally; agents keep using
  `pnpm --silent test:agent` (V1).

### Direct assets

The page, the worker, and the server's asset route together ([assets](assets.md) for `getFileSrc`'s side,
[self-host-server](self-host-server.md) for the route):

- `src/ts/bootstrap.ts` `registerSw` registers `public/sw.js` and `probeSw` fetches `/sw/init`; only a JSON answer with
  `directAssets === true` calls `setDirectAssets(true)`, so a non-JSON answer, a missing or false flag, or an older
  worker leaves it false. A `controllerchange` clears the capability and probes the new controller; only the newest
  probe can set it.
- With the capability on, `globalApi.getFileSrc` gives a page this worker controls `/api/asset/<hex>` URLs, and the
  worker signs those subresource loads with the page's key (`fetchAsset`).
- With it off, a page using the worker checks `risuCache` itself, registers a miss through `/sw/register/<hex>`, and
  loads `/sw/img/<hex>`; `/sw/check` serves only when page-side Cache Storage lookup is unavailable or fails. Without
  the worker, or when that path fails, `getFileSrc` returns an object URL. Activation drops the `/sw/img/` entries, and
  a later miss is answered from the signed route (`getSource`), so a URL handed out before still loads.

### Share target

The manifest's `share_target` POST reaches the worker's `/sw/share`, which caches the first file at `/sw/share/<kind>`
and redirects to `/#share_<kind>`. `characterCards.characterURLImport` uses `importPendingShare` to read the pending
file directly from Cache Storage even on an uncontrolled page, deleting it only after a truthy import result. A thrown,
falsy, or cancelled import retains it; missing Cache Storage or a missing entry does nothing.

### Worker Web Push

[Web Push](network-jobs.md) from the server to the worker and on to the page:

- `push` shows every completion (also with a window in front: Safari requires it) under the payload's chat tag
  (`risuai-chat-completion:<hash>`, `shared/notifications.ts` `COMPLETION_NOTIFICATION_TAG`), silent while an app window
  is in front so it does not sound after the page's `playMessage`, and closed again if one still is.
- Before the display, the app's windows are posted `risu-push-completion` with the checked chat route, and
  `src/ts/network/pushNotifications.ts` calls `refreshChatAfterPush` (`src/ts/process/serverCommands.ts`), which reads
  the chat again unless a followed job covers it. `notificationclick` focuses a window and posts `risu-open-route`,
  which `pushNotifications.ts` answers through a `MessageChannel` within 2 s, else the worker navigates the window or
  opens one.
- Each push and click leaves content-free records (`push` phases `received`, `shown`/`shownSilent`, `closedInFront`,
  `showFailed`, `clicked`; `inFront`, `focusedHidden`) in IndexedDB `risu-sw-diagnostics`, which the diagnostic report
  reads ([diagnostics](diagnostics.md)).
- `pushsubscriptionchange` is not handled: the page registers the new subscription when it opens.

## State

- Compatibility version: `version.json` and `src/ts/storage/database.svelte.ts` `appVer` (marked `APP_VERSION_POINT`),
  the upstream RisuAI release the [upstream ledger](../research/upstream-ledger.md) has triaged through. CBS
  `{{metadata::version}}` and `{{metadata::majorver}}`, card exports, the boot cache, and the server's
  `serverAppVersion` read it. `getVersionString` appends `appSubVer` when set.
- Build id: committer date (`YYYY.MM.DD`), nine hex digits of the commit, and `-dirty` when `git status` lists a change;
  `unknown` without a commit. `MainMenu.svelte` shows it above the compatibility version and copies both with the full
  commit on a click; the diagnostics report and `state.json` carry it.
- `readServerBuildInfo` reports the served client from `dist/build-info.json`, falling back to the checkout when the
  file is missing. Resource normalization uses `resolveNormalizationIdentity`: the running server checkout first, then
  the served build only without a checkout commit. A stale `dist/` must not label normalization as another server
  version.

## Coupling

- The service worker URL conventions are coupled to `bootstrap.ts`, `globalApi.getFileSrc`, and
  `characterCards.characterURLImport`. The `risuCache` name and `/sw/img/<hex>` keys are shared with the page's fallback
  asset lookup; the worker handles `/sw/register/<hex>` and `/sw/img/<hex>`, with `/sw/check/<hex>` only the client's
  lookup fallback. The worker drops the `/sw/img/` entries at activation, so the page must not treat them as durable.
- The unbundled worker's `signAssetAuth` is a hand copy of `src/ts/storage/serverAuth.ts` `createAuth`: ES256 over
  UTF-8/base64url JSON, `{ alg: "ES256", typ: "JWT" }`, and `{ iat, exp: iat + 300, pub }`. Its key location matches
  `src/ts/util.ts` `getKeypairStore("node")`: IndexedDB `DPoPDB` version 1, store `node`, key `dpop`, containing
  `{ privateKey, publicKey }`. Keep both signers in parity with a test that runs the worker against a real WebCrypto key
  and verifies its token with `server/src/routes/auth.ts` `createAuthStore().checkAuth`.

## Invariants

- Change the compatibility version in both places, only when the upstream ledger's triaged release moves. `package.json`
  `version` is not the app version.
- The build id never needs a manual bump. Builds without `.git` (Docker) need `RISU_BUILD_COMMIT`, or the id is
  `unknown`; without `RISU_BUILD_DATE` it is the hash alone, and only `RISU_BUILD_DIRTY=true` marks it dirty.
- The service worker paths (`/sw/register` and `/sw/img` with hex paths, fallback `/sw/check`, `/sw/share/*`) and Cache
  Storage `risuCache` are a contract with three consumers. Activation cleanup removes only `/sw/img/` entries: a pending
  share file must survive a worker update.
- The asset signer only reads the page's key: abort any IndexedDB upgrade so an absent database stays absent, never
  create the `node` store, and close every opened connection (including a late success after a blocked open). Cache only
  successful tokens, not keys or missing-key results; retain the destination/method/origin/client-id gate and the single
  401 retry.

## Recipes

- Change the build: `vite.config.ts`, plus the consumers of any env var (`bootstrap.ts`). Verify with `pnpm check`,
  `pnpm --silent test:agent`, `pnpm build`.
- Change the service worker: edit the hand-written `public/sw.js` and check its contracts with
  `bootstrap.ts:registerSw`, `globalApi.getFileSrc`, `characterURLImport`, and `manifest.json`. For direct assets,
  preserve the `/sw/init` capability response, interception allowlist, and signer/key-location parity with
  `serverAuth.ts` and `util.ts`; verify worker tokens with the server's `createAuthStore().checkAuth`.
- Check asset sources after changing the worker, asset route, or `getFileSrc`: run headless Chromium on the isolated
  stack under `util/playwright/offline.sh`; avoid `isolateContext` here because Playwright request routing disables the
  HTTP cache.
  - Avatars, emotions, the custom background, a module asset, and image/audio/video inlays load from `/api/asset/` with
    no `/api/read` or object URL; a video seek beyond the buffered part gets signed 206 responses.
  - Replace the worker with a chat open by registering the script under another URL for the same scope (Playwright does
    not route the worker's update check). Shown images keep loading, `/sw/img/` entries are deleted, and direct mode
    returns.
  - An SVG asset opened as a page runs no script under the CSP sandbox; an asset `<img>` in a frame with the plugin
    sandbox (no `allow-same-origin`) fails.
  - A screenshot and copy-to-HTML inline the images without a 401.
- Release: nothing to bump; the build id comes from the commit. After an upstream intake, set `version.json` and
  `appVer` to the triaged upstream release.

## Tests

Test commands, rules, and the slow-test table: [test-harness](test-harness.md).

- `src/ts/sw.share.test.ts` (node) runs `public/sw.js` under `node:vm` with a fake `self`, an in-memory `caches`, and
  Node's `Request`/`Response`/`FormData`; the manifest's `share_target` is read from `public/manifest.json`. A fake
  `clients` drives `notificationclick` and a fake `registration` drives `push`. For the push records it adds a
  `fake-indexeddb` factory, `IDBKeyRange`, its own `Date`, and timers under test control.
- `src/ts/sw.asset.test.ts` (node) runs `public/sw.js` the same way with a `fake-indexeddb` factory holding a real
  WebCrypto key, a recording `fetch`, its own `Date`, and a fake `caches` for the `/sw/img/` route.
- `server/src/tests/swAuth.test.ts` is the signer parity check: it signs with the worker's code and checks the token
  against the real auth store through `GET /api/asset/<hex>`.
- `util/agentDevHost.test.ts` and `util/agentDataSandbox.test.ts` (node) cover the `dev:agent` runner's host resolution
  and the sandbox.
- `util/{docsBudget,docsRead,docsOwner,docsContracts,docsLedger,guideReads}.test.ts` (node) run the documentation
  scripts over small fixtures in a temporary directory, through their exported functions.
- Not tested: the `/sw/check` route, the `fetch` handler's default `/sw/*` and `/tf` responses, the rest of the `push`
  display (icon, title and body fallbacks), and the userscript; verify those manually.
- Not tested: the documentation scripts' command lines (exit codes, output streams).
- Known skews of `pnpm docs:reads`: `scanTranscripts` checks a guide name only for `docs:read`, so a fixture guide path
  in a command (`a.md`) counts as a read; a title-heading read counts the title alone (`countEvent`).
- Not tested: the dev runner's process handling (process groups, the lock, the readiness wait); verify it manually when
  changing that code.

## Known Hazards

### Issues

- When a backticked path mixes source and Git-ignored runtime files in one brace expression, check each alternative. An
  ignored missing path can end validation early. See the
  [reproduction](../research/found-issues.md#an-ignored-path-can-hide-a-broken-sibling-in-a-guide).
- `tsconfig.node.json` pairs `module: ESNext` with `moduleResolution: nodenext`, producing TS5110 when checked directly.
  `pnpm check` does not include this project.

### Gotchas

- Playwright's bundled Firefox drops service worker control after a navigation the worker does not answer
  (`public/sw.js` lets every navigation fall through): the next document has
  `navigator.serviceWorker.controller === null`, so the app runs in the blob fallback instead of direct asset mode.
  Chrome keeps control, and so does a real Firefox build
  ([observation](../audit/direct-assets-browser-control-2026-10-24.md)).
- The compression step in `pnpm build` costs build time and image size. Quality 9 above 16 MiB exists because quality 11
  on the ONNX Runtime `.wasm` took too long ([numbers](../audit/build-compression-2026-10-29.md)).
