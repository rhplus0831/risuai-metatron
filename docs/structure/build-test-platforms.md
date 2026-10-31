# Build, Service Worker, Release

## Scope

- Owns:
  - package scripts,
  - Vite and TypeScript config,
  - the `dev:agent` / `dev:human` full-stack runner,
  - the documentation check,
  - the PWA service worker and manifest,
  - the userscript bridge,
  - the compatibility version and the build id,
  - repo dotfiles.
- Paths:
  - Root config: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `version.json`
  - Build id: `shared/buildInfo.ts` (`BuildInfo`, `formatBuildId`), `server/src/buildInfo.ts` (`resolveBuildInfo`,
    `readServerBuildInfo`), `src/ts/buildInfo.ts` (`buildInfo`, `buildId`)
  - Dotfiles: `.gitignore`, `.ignore`, `.gitattributes`, `.npmrc`, `.prettierrc.json`, `.prettierignore`, `.vscode/`
  - PWA files: `public/sw.js`, `public/manifest.json`, `public/logo_{16,32,192,256,512}.png`
  - `util/risuUserscript.user.js`
  - `util/agentDev.mjs`, `util/agentDevHost.mjs`, `util/agentDataSandbox.mjs` (the `dev:agent` / `dev:human` full-stack
    runner)
  - `util/docsBudget.mjs` and `util/docsBudget.json` (the `check:docs` documentation check and its ratchet)
  - `util/ci/check.sh` and `.github/workflows/ci.yml` (the CI gate and its GitHub Actions workflow)
  - `util/heap/` (V8 heap snapshot analysis)
  - `util/upstream/` (the upstream RisuAI `.bin` compatibility check)
- Not here:
  - The test wrapper, Vitest and Playwright config, test rules, and browser checks → `test-harness.md`.
  - `globalApi.svelte.ts` `fetchNative` → `global-api.md`.
  - The self-host server → `self-host-server.md`.

## Files

### Relevant `package.json` scripts

The test commands (`test*`, `check:tests`) are documented in [test-harness](test-harness.md).

| Script          | Command                                                                  | Use                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`           | `vite`                                                                   | dev server (needs `server`)                                                                                                                 |
| `build`         | `vite build --sourcemap && node util/compressDist.mjs`                   | production build with Brotli/gzip siblings (served by `server`)                                                                             |
| `check`         | `svelte-check --tsconfig ./tsconfig.json && tsc -p server/tsconfig.json` | type check (client + server)                                                                                                                |
| `check:tests`   | `node util/testInventory.mjs`                                            | test inventory: runners, slow table, product imports (no test run)                                                                          |
| `check:docs`    | `node util/docsBudget.mjs`                                               | documentation budgets and structure of `STRUCTURE.md` and the guides (no test run); `--report` prints the measurements                      |
| `test`          | `vitest run --tags-filter=!slow`                                         | tests without the `slow` tag (the gate; people and CI)                                                                                      |
| `test:agent`    | `node util/agentTest.mjs`                                                | `test` for agents: failures only, failed files rerun alone, cached (`--all` for every test; `--e2e` for the browser specs a change reaches) |
| `test:overload` | `node util/overloadTest.mjs`                                             | `test:agent` under the reference overload, three runs (Linux)                                                                               |
| `test:slow`     | `vitest run --tags-filter=slow`                                          | only the `slow` tests                                                                                                                       |
| `test:all`      | `vitest run`                                                             | every test                                                                                                                                  |
| `test:e2e`      | `node util/requireHuman.mjs "pnpm test:e2e" && playwright test`          | browser specs in `e2e/` (not in `test`; people and CI)                                                                                      |
| `server`        | `node server/src/main.ts`                                                | self-host server                                                                                                                            |
| `dev:agent`     | `node util/agentDev.mjs agent`                                           | server + Vite for agents: loopback, auth bypassed, `save-agent/` copy                                                                       |
| `dev:human`     | `node util/agentDev.mjs human`                                           | server + Vite for people: loopback, normal login, `save/`                                                                                   |
| `format`        | `prettier --write .`                                                     | formats the repository; use a targeted Prettier call for changed files                                                                      |
| `format:check`  | `prettier --check .`                                                     | repository formatting gate                                                                                                                  |

### Build compression

- `util/compressDist.mjs` runs after Vite with async `node:zlib` compression and at most four files in flight, starting
  with the largest files. It shares `STATIC_COMPRESSIBLE_EXTENSIONS` with `server/src/http/staticCache.ts`: `.js`,
  `.mjs`, `.css`, `.json`, `.svg`, and `.wasm`.
- Files below 1 KiB, HTML, source maps, and already compressed image/font/archive types receive no siblings.
- Brotli uses quality 11 through 16 MiB and quality 9 above that, text mode for text types, and a size hint; gzip uses
  level 9. Only smaller outputs remain, published through temporary files and rename.
- It prints file and byte totals plus elapsed time; any failure fails the build.
  `node util/compressDist.mjs [dist-directory]` accepts an explicit directory and otherwise uses the repository's
  `dist/`.

### Prettier config

- `.prettierrc.json`: 4-space indent, double quotes, semicolons, width 120, 2-space for JSON/YAML/Markdown,
  `prettier-plugin-svelte`, `proseWrap: "always"` for `STRUCTURE.md` and `docs/structure/`.
- `.prettierignore` includes `.ignore`'s payloads and additionally excludes all of `public/`, lockfiles, snapshots,
  `dist/`, `.claude/worktrees/`, and `src/ts/plugins/apiV3/risuai.d.ts` (a doc comment there contains a literal `*/`, so
  Prettier cannot parse it).

### Documentation check

- `pnpm check:docs` (`util/docsBudget.mjs`, plain Node over the Markdown, with a line-based parse) checks `STRUCTURE.md`
  and every guide, printing one `path:line rule message` per finding. It reads `ceilings` and `allow` from
  `util/docsBudget.json`. These fail:
  - `ceiling`: a file over its entry in `ceilings`, or over 40,000 bytes without one. `stale-ceiling`: an entry for a
    file that does not exist.
  - `paren-depth`: parentheses three deep outside code spans.
  - `sections`: a guide's `##` headings are not the nine of **Doc Maintenance** in order. `hazards`: a `Known Hazards`
    `###` other than `Issues`, `Limitations`, `Gotchas`, in that order.
  - `unresolved-link`: a relative `.md` link or `#anchor` that does not resolve, with anchors computed as GitHub does.
    `self-link`: a link to its own file without an anchor.
  - `label`: a T5 label, matched on the joined item, so a wrap cannot split it (in `STRUCTURE.md`, prose only: T5 quotes
    the labels).
- An `allow` entry `{ guide, rule, count }` accepts exactly that many findings of the rule in that guide: more are new
  findings, fewer fail as `stale-allow`. The 8,000-byte leaf and 600-character item budgets are measured and reported
  but do not fail yet. `--report` prints the sizes and every finding and exits 0.

### Config files

- `vite.config.ts`:
  - Plugins: Svelte, Tailwind (`@tailwindcss/vite`), `vite-plugin-wasm`, conditional `@rollup/plugin-strip`.
  - Dev server defaults to port 5174 with `strictPort`, listening on `0.0.0.0` (`util/agentDev.mjs` passes
    `--host`/`--port`). `cacheDir` is `RISU_VITE_CACHE_DIR` when set, else Vite's `node_modules/.vite`. The watcher
    ignores the server storage (`save/`, `save-agent/`, its lock, and its staging and previous copies).
  - It injects `globalThis.__NODE__ = true` (plugin `risu-node-flag`, `apply: "serve"`, so `dist/index.html` never
    carries it) and proxies the server routes (`/api`, `/proxy`, `/proxy2`, `/hub-proxy`, with WS) to `RISU_DEV_SERVER`
    (default `http://localhost:6001`). See `self-host-server.md` for the dev caveats.
  - `envPrefix` is Vite's default (`VITE_`). `build.minify` is `oxc`.
  - Alias `src` → `/src`. Workers are built as `es`.
  - `define` sets only `__RISU_BUILD__` (the `BuildInfo` of `resolveBuildInfo`, read through `src/ts/buildInfo.ts`;
    Vitest leaves it undefined, so tests see an unknown build). The build-only plugin `risu-build-info` writes the same
    object to `dist/build-info.json`. `manualChunks` is not set.
- `tsconfig.json`: includes `src/**/*`, `shared/**/*.ts`, and `public/sw.js`. `noEmit: true` and
  `allowImportingTsExtensions: true`: Vite builds the client and Node runs the server, so `tsc` only type-checks, and
  imports of `shared/` use explicit `.ts` extensions.
- `server/tsconfig.json`: strict, `erasableSyntaxOnly`, `lib: es2023` without DOM; includes `src/**/*.ts` and
  `../shared/**/*.ts`, so `pnpm check` strict-checks the shared persisted types.
- `tsconfig.node.json` (Vite config only) has a pre-existing `module: ESNext` / `moduleResolution: nodenext` mismatch
  (TS5110 under `tsc -p`); `pnpm check` does not build it.

### Dev runner

`util/agentDev.mjs` (`pnpm dev:agent` / `pnpm dev:human`) runs the server (`node --watch server/src/main.ts`, so a
server edit restarts it) and Vite (`--host <host> --port <port> --strictPort`, `RISU_DEV_SERVER` pointed at that server,
`https` when `server/ssl/certificate/server.key` and `server.crt` exist) as children.

- Processes: each child leads its own process group (kept after its leader exits). Ctrl+C or SIGTERM sends SIGTERM to
  each leader (the `node --watch` supervisor passes it to the server), waits until each group is empty, and sends
  SIGKILL to a group still alive after 10 s. When one child ends the rest is stopped, and nothing is started once
  stopping began.
- Before anything starts it applies the server's `readListenConfig` to the environment it will pass (a bypass off
  loopback or a bad flag ends it there) and checks both ports (taken: it exits with a message).
- Vite starts only once the server accepts connections (120 s at most): `node --watch` keeps waiting for an edit after a
  failed start, so only that first start is checked, and a later restart may fail while code is being edited.
- Host: both modes bind to `127.0.0.1` (`util/agentDevHost.mjs` `resolveAgentDevHost`): `localhost` is a secure context,
  which the login (`crypto.subtle`) and the service worker need.
  - `RISU_AGENT_DEV_HOST` binds elsewhere (an IPv6 address without brackets).
  - `tailscale` looks up this machine's Tailscale IPv4 (`tailscale ip -4`, `100.64.0.0/10`) and binds only to it (an
    error without one), and over plain HTTP that origin is no secure context.
- `agent`: server 6419, Vite 6418, `RISU_AGENT_DEV_AUTH_BYPASS=TRUE` (the server refuses it off loopback,
  `server/src/listenConfig.ts`), Vite cache `node_modules/.vite-agent` (two Vite processes sharing one cache collide
  while optimizing dependencies), storage `save-agent/` unless `RISU_SAVE_DIR` is set (then used as it is).
  - The runner prepares the storage before starting the server, so a `--watch` restart keeps it.
  - It holds `save-agent.lock` (its pid, written with `wx`) for its lifetime: a second `dev:agent` in the same checkout,
    also on other ports, refuses to start while the owner runs. A lock left by a killed runner is not taken over (two
    runners could both see the dead pid); the message says to delete it.
- `human`: server 6001, Vite 5174, the normal login, storage `save/` (or `RISU_SAVE_DIR`), Vite's default cache. It can
  run beside an agent stack.
- `util/agentDataSandbox.mjs` `prepareAgentDataSandbox` (`RISU_AGENT_DATA_MODE`):
  - `clone` (default) rebuilds `save-agent/` from `save/` on every start: `data/resources.sqlite` and
    `data/vectors.sqlite` through SQLite's online backup (read-only source, so a running human server is fine) and
    `assets/` as hard links (copies across filesystems; safe because asset writes are staged and renamed, never
    rewritten).
  - Left behind: `server/` (password, known keys, Web Push keys and subscriptions), `backups/`, `diagnostics/`,
    `data/request-history.sqlite`, `data/generation-jobs.sqlite`, `models/`, and top-level files.
  - `keep` reuses an existing sandbox (clones when there is none), `fresh` starts empty.
  - The copy is built in `.save-agent.staging-*` and swapped in (`save-agent.previous-*` during the swap); a
    symbolic-link sandbox, a non-directory, or a sandbox inside the source (or the reverse) is refused.

### Heap analysis

- `util/heap/snapshot.mjs` reads a `.heapsnapshot` larger than V8's maximum string and analyses it: `summarize`,
  `diffSnapshots`, `retainers` (over strong edges), `dominators`, and `heapReport`, the heap object counts. Retained
  sizes charge a WeakMap value to its key, as DevTools does.
- `util/heap/analyze.mjs` is its command line (usage in its header). It prints no string content and no property key
  unless asked, so user snapshots stay local data.

### Upstream `.bin` check

`util/upstream/checkBinCompat.mjs` (not in `pnpm test`; usage in its header) runs upstream RisuAI's own `.bin` database
decoder and boot defaults on this server's output. Its checks are listed in the header, and `upstreamHarness.mjs` has
the loader's `REAL`, `EXTRACT`, and `OVERRIDES` tiers in its own.

- Targets: one of two per run (`UPSTREAM_TARGETS` in `util/upstream/upstreamHarness.mjs`; one target per process,
  because the loader hooks stay registered).
  - `--target legacy` (the default, `669b12ce`): `decodeRisuSave` returns the database.
  - `--target current` (`f50b5942`): `decodeRisuSave` returns `{ database, kv }`; the check fails on another shape, or
    on a non-empty `kv` for a legacy-format file.
  - Metatron's export is the legacy format, which both targets read.
- Environment: `RISU_UPSTREAM_DIR` names an upstream checkout that holds the target's commit. `RISU_UPSTREAM_MSGPACKR`
  and `RISU_UPSTREAM_FFLATE` name package directories of the target's exact library versions (`packages`, from
  upstream's lockfile at that commit: msgpackr 1.10.1 and fflate 0.8.2 for both targets).
- Another version, an unknown target, or a checkout without the commit ends the run with `ERROR` (exit 2). It never
  installs, builds or starts the upstream app.
- Run each target in turn:
  ```bash
  P=<a node_modules/.pnpm holding msgpackr@1.10.1 and fflate@0.8.2>
  RISU_UPSTREAM_DIR=<upstream checkout> RISU_UPSTREAM_MSGPACKR=$P/msgpackr@1.10.1/node_modules/msgpackr RISU_UPSTREAM_FFLATE=$P/fflate@0.8.2/node_modules/fflate node util/upstream/checkBinCompat.mjs --target legacy
  ```
  then the same with `--target current`; each ends `OK` (exit 0) or `<n> check(s) failed` (exit 1).
- Approved uses: every import outside the loader's tiers is a recording stub, and a recorded use the check has not
  approved fails it. Each target lists its approved uses one by one, by exact label, per phase: both approve store and
  storage-instance construction at load and `changeLanguage` in the boot pass; current also approves `changeLanguage`
  and `requiresFullEncoderReload.state=` in the migration pass.
- `--bin <file>` identifies inputs by ordinal and prints array counts and fixed failure categories only, without names
  or property paths (safe to report for private files; an upstream backup's counts include its cold-storage stubs). Use
  trusted local files: upstream's decoder runs in this process.
- Not run: neither target runs upstream's backup reader (`LoadLocalBackup`) or its asset writes, `makeColdData`'s
  character and chat cold storage, `cleanChunks`, plugin loading, or the UI. No block save (`RISUSAVE`) is written or
  read.
- The migration's cold storage is in memory and starts empty, so an upstream backup's own plugin cold records are not
  read (a `_coldpluginIndex` pointer fails the migration pass under `--bin`).

### Environment variables

- `RISU_BUILD_COMMIT`, `RISU_BUILD_DATE` (`YYYY-MM-DD`), `RISU_BUILD_DIRTY` (`true`): the build id without git, as in
  the Docker build (`Dockerfile` build arguments); otherwise `resolveBuildInfo` asks git.
- `util/agentDev.mjs`: `RISU_AGENT_DEV_HOST` (default `127.0.0.1`; `tailscale`), `RISU_AGENT_DEV_PORT` (Vite; 6418
  agent, 5174 human), `RISU_AGENT_API_PORT` (server; 6419 agent, 6001 human), `RISU_AGENT_DEV_AUTH_BYPASS` (`TRUE`
  agent, `FALSE` human), `RISU_AGENT_DATA_MODE` (`clone`, `keep`, `fresh`), `RISU_SAVE_DIR`, `RISU_VITE_CACHE_DIR`.
- It sets the server's `PORT`, `RISU_HOST`, `RISU_SAVE_DIR`, and `RISU_AGENT_DEV_AUTH_BYPASS` and Vite's
  `RISU_DEV_SERVER` and `RISU_VITE_CACHE_DIR`.
- `CI`, `HUMAN`, `AGENT_TEST`: any one of them opens the human gate on the plain test commands
  ([human gate](test-harness.md#human-gate)). `CI` comes from the CI service, `HUMAN` from a person's shell,
  `AGENT_TEST` from `util/agentTest.mjs`.

### Web

- There is no mobile (Capacitor) build. Installation is only through the PWA manifest.
- `public/manifest.json`: PWA manifest. `file_handlers` for `.charx`, `.risup`, `.risum` go through `launchQueue` to
  `characterURLImport`. `share_target` posts multipart form data to the worker's `/sw/share` receiver with the
  `character` (`.charx`), `preset` (`.risup`), and `module` (`.risum`) file entries. An already installed app keeps the
  old `/receive-files/` action until the browser refreshes the manifest.
- `util/risuUserscript.user.js`: exposes `GM_fetch` as `unsafeWindow.userScriptFetch`, which `globalFetch` uses when
  present.

### Service worker

`public/sw.js`: Cache Storage `risuCache`. Routes `/sw/check`, `/sw/img/<hex>`, `/sw/register`, `/sw/init`, and
`/sw/share`. Registered by `bootstrap.ts:registerSw`. A new worker takes over at once (`skipWaiting`, `clients.claim`).

- `globalApi.getFileSrc` gives a page this worker controls `/api/asset/<hex>` URLs when its reported direct-asset
  capability is enabled; the worker signs those loads ([Direct assets](#direct-assets)).
- With the capability off, the fallback checks `risuCache` from the page, registers misses through `/sw/register/<hex>`,
  and serves assets through `/sw/img/<hex>`; `/sw/check` stays served when page-side Cache Storage lookup is unavailable
  or fails.
- `registerCache` resolves relative strings against the worker origin and still accepts URL objects.
- A share POST reads multipart form data, caches the first file in character → preset → module order at the absolute
  `/sw/share/<kind>` URL without a content type, and redirects with 303 to `/#share_<kind>`; a POST without a file and
  every non-POST (GET included) under `/sw/share` redirect with 303 to `/`.
- `characterCards.characterURLImport` uses `importPendingShare` to read the pending file directly from Cache Storage
  even on an uncontrolled page, deleting it only after a truthy import result. A thrown, falsy, or cancelled import
  retains it; missing Cache Storage or a missing entry does nothing.

### Direct assets

- Interception: same-origin paths starting with `/api/asset/` only for `GET`/`HEAD`, a non-empty string
  `event.clientId`, and destinations `image`, `audio`, `video`, `track`, `style`, or `font`. All other asset requests
  pass through without `respondWith`: cross-origin URLs, missing client ids, other methods, and destinations including
  `""` (fetch/XHR and the plugin bridge), `document`, `iframe`, `worker`, and `object`.
- The worker builds a fresh request with `risu-auth`, copies only incoming `Range` and `If-Range`, and uses
  `mode: "same-origin"`, `credentials: "omit"`, `cache: "default"`, and the incoming signal. The browser HTTP cache
  holds the bytes.
- It reuses the token until 60 seconds before expiry, with one signing promise shared by concurrent requests. A 401
  discards that token, rereads the key, and retries once; a newer token another request already obtained is reused
  instead.
- Missing keys and key-read/signing failures fall back to `fetch(request)` without added auth and are never cached;
  signed-fetch network errors and aborts stay rejected.
- `/sw/init` answers status 200 with `content-type: application/json` and `{"version":"v3","directAssets":true}`.
  `bootstrap.ts:probeSw` parses the JSON and calls `setDirectAssets(true)` only for `directAssets === true`; non-JSON
  responses, a missing/false flag, or an older worker leave it false. A `controllerchange` clears the capability and
  probes the new controller; only the newest probe can set it.
- Stored-asset copies: activation deletes every `risuCache` entry under `/sw/img/` (best effort; a cache failure does
  not stop `clients.claim()`) and keeps every other entry, including the pending `/sw/share/<kind>` files.
  `/sw/register` and `/sw/check` stay for a tab still running a client that registers bytes.
- A `/sw/img/<hex>` miss that passes the direct-asset gate above (same origin, `GET`/`HEAD`, a client id, an allowed
  destination) is answered from the signed `/api/asset/<hex>` route (same hex, `Range`/`If-Range` copied), so a URL the
  fallback handed out before the cleanup still loads; any other miss answers no response, unsigned.

### Worker Web Push

[Web Push](global-api.md) in the worker:

- `push` shows every completion (also with a window in front: Safari requires it) with the logo, the payload's chat tag
  (`risuai-chat-completion:<hash>`, one per chat, so a chat's later notice replaces only its own; a missing or foreign
  tag falls back to the bare `risuai-chat-completion`), the title and body from the payload, and a click URL that must
  be a same-origin `/chat/<chaId>/<chatId>` route, else `/`.
- In-front test: while a same-origin window is in front (`windowState`'s `inFront`: one window both focused and
  `visibilityState` `visible`, since a hidden Android PWA keeps the focus; `clients.matchAll` with uncontrolled windows;
  a failed lookup counts as none), the notification is `silent`, so it does not sound after the page's message sound
  (`playMessage`). Otherwise `silent` is left out and the platform's default applies.
- If a window is still in front once it is shown, the notification is closed. This is best effort: only the notification
  this push showed, found by its tag and a per-worker number in `data.push`, with `windowState` checked again after the
  lookup. Pushes are shown one at a time, since Chromium closes a notification by its tag.
- Before the display, the same-origin windows of that lookup are posted `risu-push-completion` with the checked chat
  route (none for `/`; a window whose post throws is skipped; `pushNotifications.ts` has the chat read again).
- `notificationclick` focuses a window of the app and posts `risu-open-route` (answered through a `MessageChannel`
  within 2 s, else the window is navigated; a navigation the browser refuses, such as of a window the worker does not
  control, opens a window instead), or opens a window.
- Each push and click also leaves content-free records: `push` phases `received`, stamped on arrival, then
  `shown`/`shownSilent`, `closedInFront`, or `showFailed`, with `inFront` and `focusedHidden` from `windowState`;
  `clicked`, stamped on the click and written whatever the window work's outcome. Fixed phases and booleans only, never
  the payload, title, body, route, endpoint, or error text.
- The records are appended to IndexedDB `risu-sw-diagnostics` (store `records`, newest 100, append and prune in one
  transaction) after the display settles and outside the display queue, so a write never delays `showNotification` or
  the next push.
- No IndexedDB, a failed or blocked open, a failed transaction, or one not done in 2 s is skipped (a late connection is
  closed, an abandoned transaction aborted), and the display's own rejection stays the event's. The diagnostic report
  reads them ([diagnostics](diagnostics.md)).
- `pushsubscriptionchange` is not handled: the page registers the new subscription when it opens.

## Flows

### Production

`pnpm build` runs Vite, then `util/compressDist.mjs` writes smaller `.br` and `.gz` siblings into `dist/`. The Hono
self-host server (`pnpm run server`, `server/src/`) negotiates those siblings for app files while keeping HTML and Range
requests as identity ([static routes](self-host-server.md#routes)). Docker runs the same build and copies `dist/` with
its siblings into the runtime image. Served any other way (static hosting), the client shows the `NodeServerRequired`
notice. There is no desktop build.

### Development

`pnpm run server` plus `pnpm dev`. Vite proxies `/api`, `/proxy`, `/proxy2`, and `/hub-proxy` to the server
(`RISU_DEV_SERVER`, default `http://localhost:6001`).

### CI

GitHub Actions runs `.github/workflows/ci.yml`, one job, `check`.

- Trigger: pushes to `metatron` and `main` and pull requests that target them (`on: push` / `pull_request` branch
  filters; nothing else starts a run, and a newer run for the same ref cancels the older one).
- Environment: `ubuntu-latest` with Node 24 (`actions/setup-node`) and `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` (no CUDA
  provider download in the postinstall). It runs `corepack enable`, so `pnpm` is the `packageManager` version.
- Steps, in `util/ci/check.sh`: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm format:check`, `pnpm check:tests`,
  `pnpm check:docs`, `CI=1 pnpm test` (no `slow` tag), and `pnpm build`, stopping at the first failure with its exit
  code and printing each step's duration. `pnpm test:slow` and `pnpm test:e2e` are not in CI.
- The pnpm store is kept outside the checkout at `$RUNNER_TEMP/pnpm-store` (`PNPM_STORE_DIR`, which the script passes to
  `pnpm install`) and cached with `actions/cache`, keyed on `pnpm-lock.yaml`.
- The job uses no secrets and no `save/` data. A person can run the same script locally (it checks the Node and pnpm
  versions first); agents keep using `pnpm --silent test:agent` (V1).

## State

- Compatibility version: `version.json` and `src/ts/storage/database.svelte.ts` `appVer` (marked `APP_VERSION_POINT`),
  the upstream RisuAI release the [upstream ledger](../research/upstream-ledger.md) has triaged through. CBS
  `{{metadata::version}}` and `{{metadata::majorver}}`, card exports, the boot cache, and the server's
  `serverAppVersion` read it. `getVersionString` appends `appSubVer` when set.
- Build id: `2026.10.26 · a9fa6f8c5` (committer date, nine hex digits of the commit, `-dirty` when `git status` lists a
  change), or `unknown`. The home menu (`MainMenu.svelte`) shows it above the compatibility version and copies both with
  the full commit on a click; the diagnostics report and `state.json` carry it.

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
- Not tested: the `/sw/check` route, the `fetch` handler's default `/sw/*` and `/tf` responses, the rest of the `push`
  display (icon, title and body fallbacks), and the userscript; verify those manually.
- Not tested: the dev runner's process handling (process groups, the lock, the readiness wait); verify it manually when
  changing that code.

## Known Hazards

### Gotchas

- Playwright's bundled Firefox drops service worker control after a navigation the worker does not answer
  (`public/sw.js` lets every non-`/sw/` request fall through): the next document has
  `navigator.serviceWorker.controller === null`, so the app runs in the blob fallback instead of direct asset mode.
  Chrome keeps control, and so does a real Firefox build
  ([observation](../audit/direct-assets-browser-control-2026-10-24.md)).
- A Firefox browser check of direct asset mode under Playwright therefore reads as broken; check it in Chromium or a
  real Firefox. `probeDirectAssets.mjs` reports the Playwright case as a failed check.
- The compression step in `pnpm build` costs build time and image size. Quality 9 above 16 MiB exists because quality 11
  on the ONNX Runtime `.wasm` took too long ([numbers](../audit/build-compression-2026-10-29.md)).
