# Build, Test Harness, Service Worker, Release

## Scope

- Owns:
  - package scripts,
  - Vite, Vitest, and TypeScript config,
  - the test inventory,
  - the PWA service worker and manifest,
  - the userscript bridge,
  - version bumping,
  - repo dotfiles.
- Paths:
  - Root config: `package.json`, `vite.config.ts`, `vitest.config.ts`, `vitest.setup.ts`, `vitest.lucideImports.ts`, `playwright.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `version.json`
  - Dotfiles: `.gitignore`, `.ignore`, `.gitattributes`, `.npmrc`, `.vscode/`
  - `public/sw.js`, `public/manifest.json`
  - `util/risuUserscript.user.js`
  - `util/agentDev.mjs`, `util/agentDevHost.mjs`, `util/agentDataSandbox.mjs` (the `dev:agent` / `dev:human` full-stack runner)
  - `util/agentTest.mjs`, `util/agentTestReporter.ts` (the `test:agent` wrapper and its reporter), `util/requireHuman.mjs` (the human gate)
  - `util/playwright/` (browser automation helpers and capture scripts), `e2e/` (Playwright specs)
- Not here:
  - `globalApi.svelte.ts` `fetchNative` → `global-api.md`.
  - The self-host server → `self-host-server.md`.

## Files

Relevant `package.json` scripts:

| Script         | Command                                                                  | Use                                                                    |
| -------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `dev`          | `vite`                                                                   | dev server (needs `server`)                                            |
| `build`        | `vite build --sourcemap`                                                 | production build (served by `server`)                                  |
| `check`        | `svelte-check --tsconfig ./tsconfig.json && tsc -p server/tsconfig.json` | type check (client + server)                                           |
| `test`         | `vitest run --tags-filter=!slow`                                         | tests without the `slow` tag (the gate; people and CI)                 |
| `test:agent`   | `node util/agentTest.mjs`                                                | `test` for agents: failures only, cached (`--all` for every test)      |
| `test:slow`    | `vitest run --tags-filter=slow`                                          | only the `slow` tests                                                  |
| `test:all`     | `vitest run`                                                             | every test                                                             |
| `test:e2e`     | `node util/requireHuman.mjs "pnpm test:e2e" && playwright test`          | browser specs in `e2e/` (not in `test`; people and CI)                 |
| `server`       | `node server/src/main.ts`                                                | self-host server                                                       |
| `dev:agent`    | `node util/agentDev.mjs agent`                                           | server + Vite for agents: loopback, auth bypassed, `save-agent/` copy  |
| `dev:human`    | `node util/agentDev.mjs human`                                           | server + Vite for people: loopback, normal login, `save/`              |
| `format`       | `prettier --write .`                                                     | formats the repository; use a targeted Prettier call for changed files |
| `format:check` | `prettier --check .`                                                     | repository formatting gate                                             |

- Prettier config lives in `.prettierrc.json` (4-space indent, double quotes, semicolons, width 120, 2-space for JSON/YAML/Markdown, `prettier-plugin-svelte`). `.prettierignore` mirrors `.ignore` plus lockfiles, snapshots, `dist/`, and `src/ts/plugins/apiV3/risuai.d.ts` (a doc comment there contains a literal `*/`, so Prettier cannot parse it).

Config files:

- `vite.config.ts`:
  - Plugins: Svelte, Tailwind (`@tailwindcss/vite`), `vite-plugin-wasm`, conditional `@rollup/plugin-strip`.
  - Dev server defaults to port 5174 with `strictPort`, listening on `0.0.0.0` (`util/agentDev.mjs` passes `--host`/`--port`). `cacheDir` is `RISU_VITE_CACHE_DIR` when set, else Vite's `node_modules/.vite`. The watcher ignores the server storage (`save/`, `save-agent/`, its lock, and its staging and previous copies). It injects `globalThis.__NODE__ = true` (plugin `risu-node-flag`, `apply: "serve"`, so `dist/index.html` never carries it) and proxies the server routes (`/api`, `/proxy`, `/proxy2`, `/hub-proxy`, with WS) to `RISU_DEV_SERVER` (default `http://localhost:6001`). See `self-host-server.md` for the dev caveats.
  - `envPrefix` is Vite's default (`VITE_`). `build.minify` is `oxc`.
  - Alias `src` → `/src`. Workers are built as `es`.
  - Neither `define` nor `manualChunks` is set.
- `util/requireHuman.mjs`: the human gate. `requireHuman(command)` prints a notice (what to run as an agent, how to set `HUMAN` as a person) and exits with 1 unless `CI`, `HUMAN`, or `AGENT_TEST` is set; it exits instead of throwing so the caller shows no stack trace. `vitest.config.ts` calls it at load, which covers `pnpm test`, `pnpm test:slow`, `pnpm test:all`, and a direct `vitest` (every run loads the config once in the main process; the Vitest VS Code extension loads it too, so that editor needs `HUMAN` in its environment). `pnpm test:e2e` runs the file's command-line form (`node util/requireHuman.mjs "<command>"`) before Playwright. `util/agentTest.mjs` sets `AGENT_TEST=1` for the run it supervises. Agents must use the wrapper and must not set `HUMAN` or `AGENT_TEST` themselves to bypass this convention.
- `vitest.config.ts`: `requireHuman("vitest")` at load (see above), Svelte plugin (`configFile: false`: there is no `svelte.config.js`, and the lookup would log a line on every run), the test-only `lucideImports` plugin, `src` alias, browser resolve conditions, `happy-dom`, setup file `vitest.setup.ts`, default include pattern, `e2e/**` excluded (Vitest's default include also matches the Playwright `*.spec.ts` files), and `.claude/**` excluded (Claude Code worktrees under `.claude/worktrees/` are checkouts of other branches, so a run in the main checkout would collect their tests too).
- `util/agentTest.mjs` (`pnpm --silent test:agent [--force] [--verbose] [--all] [vitest args]`): `pnpm test` for agents, and the only test command that runs without `CI` or `HUMAN` (the child gets `AGENT_TEST=1`). It runs `vitest run --tags-filter=!slow` (`--all` drops the tag filter, like `pnpm test:all`; `--tags-filter=slow` is `pnpm test:slow`; an explicit `--tags-filter` replaces the default; other arguments, such as a file filter, pass through) with `util/agentTestReporter.ts` and caches the result in `node_modules/.cache/agent-test/<args hash>.json`. The key is the working tree's `git write-tree` id, taken from a copy of the real index with every change staged (untracked files included, `.gitignore` honored, so unchanged files keep their stat cache), plus the Node and Vitest versions and the arguments. On a hit it prints a `[agent-test] cached result ...` line, the stored stdout, and exits with the stored code; failures are cached too, since the same tree gives the same result, and `--force` runs anyway and replaces the entry. Stderr of the run (Node warnings, worker-thread traces from passing tests) is held back: a passing run only reports its line count, a failing run prints the last 60 lines after the report, `--verbose` prints all of it. Outside git it runs without the cache. An interrupted run caches nothing. `pnpm --silent test:agent` also drops pnpm's own banner lines.
- `util/agentTestReporter.ts`: a Vitest reporter that prints nothing while tests run and then, per failure, `FAIL <file> > <suite> > <test>`, the error message, the diff (or `expected:`/`actual:`), the in-repo stack frames (no `node_modules`, Node internals, or anonymous frames; none when no frame is in the repository), the cause chain, and that test's console output (`--silent=passed-only` is not needed: logs are buffered per task and printed only under a failure), then one summary line: `OK <n> passed, <n> skipped (<files>, <s>s)` or `FAIL <n> failed, <n> passed, ... (<k> of <files> failed, <s>s)`. Module and suite errors (import failures, `beforeAll` throws) and unhandled errors are listed the same way. Diffs, values, logs, and frames are capped.
- `vitest.lucideImports.ts` `lucideImports`: rewrites `import { Icon, A as B } from "@lucide/svelte"` into one `@lucide/svelte/icons/<file>` default import per icon, from a map read off the package's own re-export lines, keeping the statement's line count. Without it every test that reaches an icon imports all of them (about 15 s per file); pre-bundling the package (`deps.optimizer`) instead gives the icons their own Svelte runtime and breaks mounting them. A statement with a name the map lacks is left on the main entry. Tests only: the build tree-shakes and the dev server pre-bundles.
- `util/agentDev.mjs` (`pnpm dev:agent` / `pnpm dev:human`): runs the server (`node --watch server/src/main.ts`, so a server edit restarts it) and Vite (`--host <host> --port <port> --strictPort`, `RISU_DEV_SERVER` pointed at that server, `https` when `server/ssl/certificate/server.key` and `server.crt` exist) as children, each leading its own process group (kept after its leader exits); Ctrl+C or SIGTERM sends SIGTERM to each leader (the `node --watch` supervisor passes it to the server), waits until each group is empty, and sends SIGKILL to a group still alive after 10 s; when one child ends the rest is stopped, and nothing is started once stopping began. Before anything starts it applies the server's `readListenConfig` to the environment it will pass (a bypass off loopback or a bad flag ends it there) and checks both ports (taken: it exits with a message). Vite starts only once the server accepts connections (120 s at most): `node --watch` keeps waiting for an edit after a failed start, so only that first start is checked, and a later restart may fail while code is being edited.
  - Both modes bind to `127.0.0.1` (`util/agentDevHost.mjs` `resolveAgentDevHost`): `localhost` is a secure context, which the login (`crypto.subtle`) and the service worker need. `RISU_AGENT_DEV_HOST` binds elsewhere (an IPv6 address without brackets); `tailscale` looks up this machine's Tailscale IPv4 (`tailscale ip -4`, `100.64.0.0/10`) and binds only to it (an error without one), and over plain HTTP that origin is no secure context.
  - `agent`: server 6419, Vite 6418, `RISU_AGENT_DEV_AUTH_BYPASS=TRUE` (the server refuses it off loopback, `server/src/listenConfig.ts`), Vite cache `node_modules/.vite-agent` (two Vite processes sharing one cache collide while optimizing dependencies), storage `save-agent/` unless `RISU_SAVE_DIR` is set (then used as it is). The runner prepares it before starting the server, so a `--watch` restart keeps it, and holds `save-agent.lock` (its pid, written with `wx`) for its lifetime: a second `dev:agent` in the same checkout, also on other ports, refuses to start while the owner runs. A lock left by a killed runner is not taken over (two runners could both see the dead pid); the message says to delete it.
  - `human`: server 6001, Vite 5174, the normal login, storage `save/` (or `RISU_SAVE_DIR`), Vite's default cache. It can run beside an agent stack.
  - `util/agentDataSandbox.mjs` `prepareAgentDataSandbox` (`RISU_AGENT_DATA_MODE`): `clone` (default) rebuilds `save-agent/` from `save/` on every start: `data/resources.sqlite` and `data/vectors.sqlite` through SQLite's online backup (read-only source, so a running human server is fine) and `assets/` as hard links (copies across filesystems; safe because asset writes are staged and renamed, never rewritten). `server/` (password, known keys, Web Push keys and subscriptions), `backups/`, `diagnostics/`, `data/request-history.sqlite`, `models/`, and top-level files are left behind. `keep` reuses an existing sandbox (clones when there is none), `fresh` starts empty. The copy is built in `.save-agent.staging-*` and swapped in (`save-agent.previous-*` during the swap); a symbolic-link sandbox, a non-directory, or a sandbox inside the source (or the reverse) is refused.
- `playwright.config.ts`: specs in `e2e/**/*.spec.ts`, one worker, the system Chrome (`/usr/bin/google-chrome`, override with `RISU_CHROME`; no browser download), `baseURL` `http://localhost:5201`. `globalSetup` is `util/playwright/globalSetup.mjs`, which starts one isolated stack per run.
- `util/playwright/stack.mjs`: `startStack({ serverPort, vitePort, serverEnv })` runs `server/src/main.ts` in a fresh temporary working directory (with `RISU_SAVE_DIR` pinned to its `save/` and the shell's `RISU_HOST` and `RISU_AGENT_DEV_AUTH_BYPASS` dropped, so the store starts empty, the repository `save/` is never touched, and auth is real) and the Vite dev server with `RISU_DEV_SERVER` pointing at it (`serverEnv` adds to the server's environment only, e.g. `NODE_OPTIONS` with a check's `--import` preload; without one the server gets a `fetch` egress tripwire, `deniedEgress()`); `isolateContext(context)` keeps a browser context's HTTP requests on local hosts and `unexpectedEgress` filters the expected blocks (CDN stylesheets, the hub listing). `util/playwright/offline.sh <command>` runs a check in a user and network namespace with loopback only (`unshare -rn`): the boundary that keeps the stack, the browser, and the mocks off public services, whatever the transport; `stop()` ends both and deletes the directory. `openApp(page, baseURL)` answers the node-password prompts and waits for `loadedStore`. Page code reaches app modules with `await import("/src/...")`, which is the same module instance the app uses; a two-client check opens a second browser context (tabs of one context share `localStorage`).
- `util/playwright/capturePhase3Fixtures.mjs`: captures the Phase 3 pre-phase fixtures in `src/ts/storage/tests/fixtures/phase3/` (see its README).
- `util/playwright/captureTokenizerIds.mjs` and `util/playwright/capturePhase5Baseline.mjs`: capture the Phase 5 browser-path fixtures in `server/src/tests/fixtures/tokens/` (per-family token ids) and `server/src/tests/fixtures/baseline/` (preview prompts, `ParseMarkdown` HTML, `encode` routing, lore regex, the `igp` send; see its README for how randomness, time, the viewport, settings, and the network were controlled). `capturePhase5Baseline.mjs` drives the browser path the Phase 5 cutover removed (it imports `src/ts/process/scripts.ts`), so it runs only on a checkout at `219dfb51` or earlier.
- The check and measurement scripts in `util/playwright/` (each script's header has its usage). Against the dev stack: `checkLiveUpdates.mjs` (two contexts and a third writer through the routes, a restart, an archive restore), `checkCutoverCredentials.mjs` and `checkLlmTransport.mjs` (no provider key in the browser's traffic), `checkStreamingModes.mjs`, `checkServerTransform.mjs`, `checkMcpFixes.mjs`, `checkSidebarChatStatus.mjs` (generating badges on pins, characters, and folders; unseen badges on pins, folders, and home cards; keyboard reopening and clearing; also supports `--base`), `checkBootCache.mjs` (the snapshot a tab hands to `seedResources` through the boot cache equals a plain read after cold, warm, edited, reordered, deleted, created, and fallback boots; it wraps `loadBootSnapshot` as Vite serves `src/ts/storage/bootCache.ts`, waits for `loadedStore` and captures the snapshot in the same document without another navigation, fails if loading times out, checks every boot request for credential claims, and checks full-cache claims against the compared document). Against a running production server, normally the Docker image on a fresh volume (`--base`, `--password`; a mock provider named by `--provider-host`): `checkStopBSmoke.mjs`, `checkStopCSmoke.mjs`, `checkStopDSmoke.mjs` (two browsers, a send with a sentinel key absent from both browsers' traffic, `--restart-cmd`, an archive import, and a snapshot restore), `checkServerSend.mjs`, `checkServerButton.mjs`, `checkServerTrigger.mjs`, `checkStopDMatrix.mjs`. Measurements: `measureRecords.mjs`, `measureCharacters.mjs`, and `measureChats.mjs` (a production build in headless Chrome; `RISU_DIST` measures another build as the baseline), `measureBoot.mjs` (the boot read and the boot cache on a production build: synthetic asset-heavy modules, a CDP-throttled network, the plain uncompressed read against cold, warm, and edited boots; it blocks the page's four known public hosts through CDP instead of `isolateContext`, because Playwright's request routing turns the HTTP cache off, and fails on a page request to any other host; the server's egress is not guarded; startup probes the port before spawning and requires the child's listening URL on stdout before accepting an HTTP answer) and `measureTransformLua.mjs` (the display transform's Lua cost, the server in process).
- `vitest.setup.ts`: mocks KaTeX, sets `globalThis.safeStructuredClone` to a JSON clone, and
  patches happy-dom's `Node.prototype.nodeName` getter so it dispatches by node type. DOMPurify
  > = 3.4.6 reads tag names through that prototype getter, which happy-dom leaves returning `""`
  > (capricorn86/happy-dom#2182); without the patch the sanitizer strips every element under
  > happy-dom. The patch is guarded, runs only under the happy-dom environment, and its contract is
  > pinned by `vitest.setup.test.ts`. Remove both once happy-dom fixes the getter.
- `tsconfig.json`: includes `src/**/*`, `shared/**/*.ts`, and `public/sw.js`. `noEmit: true` and `allowImportingTsExtensions: true`: Vite builds the client and Node runs the server, so `tsc` only type-checks, and imports of `shared/` use explicit `.ts` extensions.
- `server/tsconfig.json`: strict, `erasableSyntaxOnly`, `lib: es2023` without DOM; includes `src/**/*.ts` and `../shared/**/*.ts`, so `pnpm check` strict-checks the shared persisted types. `tsconfig.node.json` (Vite config only) has a pre-existing `module: ESNext` / `moduleResolution: nodenext` mismatch (TS5110 under `tsc -p`); `pnpm check` does not build it.

Environment variables:

- `VITE_RISU_NIGHTLY_BUILD`, `VITE_RISU_BUILD_TIME`.
- `util/agentDev.mjs`: `RISU_AGENT_DEV_HOST` (default `127.0.0.1`; `tailscale`), `RISU_AGENT_DEV_PORT` (Vite; 6418 agent, 5174 human), `RISU_AGENT_API_PORT` (server; 6419 agent, 6001 human), `RISU_AGENT_DEV_AUTH_BYPASS` (`TRUE` agent, `FALSE` human), `RISU_AGENT_DATA_MODE` (`clone`, `keep`, `fresh`), `RISU_SAVE_DIR`, `RISU_VITE_CACHE_DIR`. It sets the server's `PORT`, `RISU_HOST`, `RISU_SAVE_DIR`, and `RISU_AGENT_DEV_AUTH_BYPASS` and Vite's `RISU_DEV_SERVER` and `RISU_VITE_CACHE_DIR`.
- `CI`, `HUMAN`, `AGENT_TEST`: any one of them opens the human gate on the plain test commands (`util/requireHuman.mjs`). `CI` comes from the CI service, `HUMAN` from a person's shell, `AGENT_TEST` from `util/agentTest.mjs`.

Web:

- There is no mobile (Capacitor) build. Installation is only through the PWA manifest.
- `public/sw.js`: Cache Storage `risuCache`. Routes `/sw/check`, `/sw/img/<hex>`, `/sw/register`, `/sw/init`, and `/sw/share`. `globalApi.getFileSrc` checks `risuCache` directly from the page, registers misses through `/sw/register/<hex>` and serves assets through `/sw/img/<hex>`; `/sw/check` stays served as the fallback when page-side Cache Storage lookup is unavailable or fails. A share POST reads multipart form data, caches the first file in character → preset → module order at the absolute `/sw/share/<kind>` URL without a content type, and redirects with 303 to `/#share_<kind>`; a POST without a file and every non-POST (GET included) under `/sw/share` redirect with 303 to `/`. `registerCache` resolves relative strings against the worker origin and still accepts URL objects. Registered by `bootstrap.ts:registerSw`; `characterCards.characterURLImport` uses `importPendingShare` to read the pending file directly from Cache Storage even on an uncontrolled page, deleting it only after a truthy import result. A thrown, falsy, or cancelled import retains it; missing Cache Storage or a missing entry does nothing. A new worker takes over at once (`skipWaiting`, `clients.claim`). Web Push ([Web Push](global-api.md)): `push` shows every completion (also with a window in front: Safari requires it) with the logo and the fixed tag, the title and body from the payload, and a click URL that must be a same-origin `/chat/<chaId>/<chatId>` route, else `/`; `notificationclick` focuses a window of the app and posts `risu-open-route` (answered through a `MessageChannel` within 2 s, else the window is navigated; a navigation the browser refuses, such as of a window the worker does not control, opens a window instead), or opens a window. `pushsubscriptionchange` is not handled: the page registers the new subscription when it opens.
- `public/manifest.json`: PWA manifest. `file_handlers` for `.charx`, `.risup`, `.risum` go through `launchQueue` to `characterURLImport`. `share_target` posts multipart form data to the worker's `/sw/share` receiver with the `character` (`.charx`), `preset` (`.risup`), and `module` (`.risum`) file entries. An already installed app keeps the old `/receive-files/` action until the browser refreshes the manifest.
- `util/risuUserscript.user.js`: exposes `GM_fetch` as `unsafeWindow.userScriptFetch`, which `globalFetch` uses when present.

## Flows

- Production: `pnpm build` produces `dist/`, which only the Hono self-host server (`pnpm run server`, `server/src/`) or Docker serves. Served any other way (static hosting), the client shows the `NodeServerRequired` notice.
- Development: `pnpm run server` plus `pnpm dev`.
- There is no desktop build. The Tauri shell (`src-tauri/`), its `@tauri-apps/*` packages, the updater, and the Python llama.cpp sidecar were removed.

## State

- Version: `version.json` and `src/ts/storage/database.svelte.ts` `appVer` (marked `APP_VERSION_POINT`). `getVersionString` appends `appSubVer` or the nightly label.

## Coupling

- The service worker URL conventions are coupled to `bootstrap.ts`, `globalApi.getFileSrc`, and `characterCards.characterURLImport`. The `risuCache` name and `/sw/img/<hex>` keys are shared with the page's direct asset lookup; the worker handles `/sw/register/<hex>` and `/sw/img/<hex>`, with `/sw/check/<hex>` only the client's lookup fallback.

## Invariants

- Bump the version in both places. `package.json` `version` is not the app version.
- The service worker paths (`/sw/register` and `/sw/img` with hex paths, fallback `/sw/check`, `/sw/share/*`) and Cache Storage `risuCache` are a contract with three consumers.

## Recipes

- Change the build: `vite.config.ts`, plus the consumers of any env var (`bootstrap.ts`). Verify with `pnpm check`, `pnpm --silent test:agent`, `pnpm build`.
- Change the service worker: `public/sw.js`, `bootstrap.ts:registerSw`, `globalApi.getFileSrc`, `characterURLImport`, and `manifest.json`.
- Release: bump `version.json` and `appVer`.
- Add a slow test: first try to make it fast (a test-only option for the limit, as
  `createScriptWorkerPool`'s `syncHostTimeoutMs` and `sleepCaps`). Tag it `slow` only when the cost
  is the subject: a real wall-clock limit, a real production limit, cold loads of every tokenizer, or
  a fresh Node process. Tag a test with `{ tags: ["slow"] }` (the timeout goes in the same object)
  and a whole file with a `/** @module-tag slow */` comment, then update the slow-test selection table in
  `Tests`. The tag is defined in `vitest.config.ts`; an undefined tag fails the run.

## Tests

Agents run `pnpm --silent test:agent` for the default fast suite. Use
`pnpm --silent test:agent --tags-filter=slow` for affected slow coverage or
`pnpm --silent test:agent --all` for both. `--force` bypasses the tree cache;
file filters and other Vitest arguments pass through. Passing output is a current
run result, not a permanent property of this guide.

Slow tests cover real wall-clock/production limits, cold tokenizers, or fresh Node
processes. Select them when touching the last column below. Discover current tags
with `rg -n 'module-tag slow|tags:.*slow' server/src shared src` rather than relying
on a count or timing estimate.

| Test (file in `server/src/tests/`)                                                                                                                     | Covers                                                                                                                                                                                | Run after changing                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `tokenPlainNode.test.ts` (the whole file)                                                                                                              | Every tokenizer family loaded cold and concurrently in a plain `node` process from a dist-only root, with the browser's ids; the `loadAll` entry's report and exit codes              | `server/src/prompt/tokenizers/`, `public/token/`, the Dockerfile's `dist/token` layout |
| `tokenParity.test.ts` "counts the smoke strings for every family as the browser does"                                                                  | `loadAll` in process: a cold load of every family                                                                                                                                     | `server/src/prompt/tokenizers/`, `public/token/`                                       |
| `diagnosticsCrash.test.ts` (the whole file)                                                                                                            | The `uncaughtExceptionMonitor` of `main.ts` in a plain `node` process: an uncaught exception and an unhandled rejection each recorded with `state.json` written, exit 1               | `server/src/diagnostics/journal.ts`, `server/src/main.ts`                              |
| `scriptWorker.test.ts` "caps sleep at 2 s per call and 6 s per run"                                                                                    | Lua `sleep` at the production caps (`MAX_SLEEP_MS`, `MAX_TOTAL_SLEEP_MS`); a fast version runs at `sleepCaps` of 200/600 ms                                                           | `server/src/lua/runtime.ts`, `server/src/scripts/`                                     |
| `scriptWorker.test.ts` "charges a C-level runaway that follows the worker's own 10 s give-up"                                                          | The watchdog after a synchronous host call times out at the production `SYNC_HOST_TIMEOUT_MS`; a fast version runs at `syncHostTimeoutMs: 1000`                                       | `server/src/scripts/`                                                                  |
| `luaRuntime.test.ts` "pins the address, verifies the URL's host, ... and answers 408 on the deadline"                                                  | The pinned TLS transport in a fresh process against a local HTTPS server, including the real 10 s request deadline                                                                    | `server/src/lua/egress.ts`                                                             |
| `manualTriggers.test.ts` "ends the job with an error past the effect limit (the tab would loop forever)"                                               | A manual trigger job that loops to the real 100,000-effect limit (`MAX_TRIGGER_EFFECTS`)                                                                                              | `server/src/prompt/triggers.ts`, `server/src/jobs/`                                    |
| `triggerRuntime.test.ts` "ends a privileged self-recursion with the job's effect limit, not a stack overflow"                                          | `v2RunTrigger` self-recursion to the real effect limit, without a stack overflow                                                                                                      | `server/src/prompt/triggers.ts`                                                        |
| `triggerRuntime.test.ts` "ends `/trigger` recursion through the real command executor with the same shared limit"                                      | `/trigger` recursion through the real command executor sharing that limit                                                                                                             | `server/src/prompt/triggers.ts`, `server/src/prompt/commands.ts`                       |
| `promptRunner.test.ts` "writes the checkpoint 3 s after a chunk while the provider stalls, before any other chunk"                                     | The stream checkpoint on its real 3 s timer while the provider stalls                                                                                                                 | `server/src/prompt/runner.ts` (`CHECKPOINT_INTERVAL_MS`)                               |
| `cbsLimits.test.ts` "the stuck range, an endless roll, ... all end with the limit error" and "an ordinary large text passes under the server's limits" | The production CBS limits (`serverCbsLimits`) in a fresh Node process: runaway templates end with the work limit inside the real 5 s wall limit, a large legal text passes under both | `shared/cbs/`, `server/src/jobs/cbsHost.ts`                                            |

`triggerRuntime.test.ts` "ends an endless loop with the limit" still covers the effect limit in the default agent suite.

Focused tests belong to the guide for the code under test. Use
[STRUCTURE's task router](../../STRUCTURE.md#choose-by-task) instead of copying
those inventories here. Discover current files with:

```sh
rg --files src server/src shared | rg '\.test\.ts$'
rg --files e2e | rg '\.spec\.ts$'
rg --files util/playwright
```

The browser inventory includes API-key and lazy-chat specs as well as preset,
persona/binding, transform, storage, settings, character, and navigation flows.
`e2e/0-idleReload.spec.ts` must run first because it asserts the shared stack's first
boot; `e2e/welcomeAndChatSettings.spec.ts` runs last because it changes the shared stack's settings.
Domain guides retain their specific assertions and browser gaps.

- `util/agentDevHost.test.ts` and `util/agentDataSandbox.test.ts` (node) cover the `dev:agent` runner's host resolution (loopback default, brackets refused, the `tailscale` lookup and its failure, the Tailscale range) and the sandbox (a clone from a source whose database is open in WAL mode: the databases readable, assets hard-linked, `server/`, `backups/`, `diagnostics/`, request history, models, and loose files left behind, no staging left over; `keep`, `fresh`, a missing source; the containment, symbolic-link, and non-directory refusals). The runner's process handling (process groups, the lock, the readiness wait) has no automated test; it was checked by hand.
- `src/ts/sw.share.test.ts` (node) runs `public/sw.js` under `node:vm` with a fake `self`, an in-memory `caches`, and Node's `Request`/`Response`/`FormData`: the manifest's `share_target` (read from `public/manifest.json`) posts to the worker's `/sw/share`, a multipart POST stores the first file (character, then preset, then module) under the absolute `/sw/share/<kind>` URL and answers a 303 to `/#share_<kind>`, a POST without one and a GET answer a 303 to `/` without reading the form, and `/sw/register` with a URL object still stores the bytes. Slice 4f (audit WEB-01). It also runs `notificationclick` with a fake `clients`: a window that does not answer is navigated, and one whose navigation is refused falls back to `openWindow` with the chat route. The worker's other routes, the `push` handler, and the userscript have no automated tests; verify those manually.
- Browser checks use Playwright against the stack above: plain `playwright-core` scripts in `util/playwright/` for captures and one-off observations, `@playwright/test` specs in `e2e/` for repeatable checks (`pnpm test:e2e`). `playwright.config.ts`, `e2e/`, and `util/playwright/` are outside `tsconfig.json`'s include, so `pnpm check` does not type-check them.
- A check that points the stack at a mock provider writes a model profile and the model preset's slots ([model profiles and slots](llm-requests.md)), never `aiModel`, `forceReplaceUrl`, or `maxContext` on a `presets` record, whose normalizer drops them without an error. Use `util/playwright/modelProfiles.mjs` (`modelFixtureOps` for the batch, `promptFixture` for the prompt half) or, in the page, `modelProfiles.browser.mjs` (`applyModelFixtureSettings`).
- A check that sends binds its chat ([chat bindings](persistence.md): a chat without a complete binding is not sent): spread `chatBindingFixture(modelPresets, presets, personas)` (`util/playwright/modelProfiles.mjs`, the first record of each list, the model preset `modelFixtureOps` points at the mock) into the seeded chat.

## Known Hazards

- Import lucide icons as plain names (`import { X, Check as Ok } from "@lucide/svelte"`). Another form (a type, `icons`, a default or namespace import) keeps that statement on the package's main entry, and every test that reaches it imports all the icons again (about 15 s per file); `vitest.lucideImports.test.ts` fails on it.
- A Vitest file that reaches the settings views or the records needs the client environment (happy-dom): the records use Svelte's client `$state`, so `@vitest-environment node` fits only pure schema tests. Install a flat fixture with `src/ts/storage/tests/installFlatDatabase.ts`.
