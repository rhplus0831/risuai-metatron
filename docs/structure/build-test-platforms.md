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
  - Root config: `package.json`, `vite.config.ts`, `vitest.config.ts`, `vitest.setup.ts`, `playwright.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `version.json`
  - Dotfiles: `.gitignore`, `.ignore`, `.gitattributes`, `.npmrc`, `.vscode/`
  - `public/sw.js`, `public/manifest.json`
  - `util/risuUserscript.user.js`
  - `util/playwright/` (browser automation helpers and capture scripts), `e2e/` (Playwright specs)
- Not here:
  - `globalApi.svelte.ts` `fetchNative` → `global-api.md`.
  - The self-host server → `self-host-server.md`.

## Files

`package.json` scripts:

| Script      | Command                                                                  | Use                                      |
| ----------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `dev`       | `vite`                                                                   | dev server (needs `runserver`)           |
| `build`     | `vite build --sourcemap`                                                 | production build (served by `runserver`) |
| `check`     | `svelte-check --tsconfig ./tsconfig.json && tsc -p server/tsconfig.json` | type check (client + server)             |
| `test`      | `vitest run`                                                             | tests                                    |
| `test:e2e`  | `playwright test`                                                        | browser specs in `e2e/` (not in `test`)  |
| `runserver` | `node server/src/main.ts`                                                | self-host server                         |

- Prettier config lives in `.prettierrc.json` (4-space indent, double quotes, semicolons, width 120, 2-space for JSON/YAML/Markdown, `prettier-plugin-svelte`). `.prettierignore` mirrors `.ignore` plus lockfiles, snapshots, `dist/`, and `src/ts/plugins/apiV3/risuai.d.ts` (a doc comment there contains a literal `*/`, so Prettier cannot parse it).

Config files:

- `vite.config.ts`:
  - Plugins: Svelte, Tailwind (`@tailwindcss/vite`), `vite-plugin-wasm`, conditional `@rollup/plugin-strip`.
  - Dev server is fixed at port 5174 with `strictPort`, listening on `0.0.0.0`. It injects `globalThis.__NODE__ = true` (plugin `risu-node-flag`, `apply: "serve"`, so `dist/index.html` never carries it) and proxies the server routes (`/api`, `/proxy`, `/proxy2`, `/hub-proxy`, with WS) to `RISU_DEV_SERVER` (default `http://localhost:6001`). See `self-host-server.md` for the dev caveats.
  - `envPrefix` is Vite's default (`VITE_`). `build.minify` is `oxc`.
  - Alias `src` → `/src`. Workers are built as `es`.
  - Neither `define` nor `manualChunks` is set.
- `vitest.config.ts`: Svelte plugin, `src` alias, browser resolve conditions, `happy-dom`, setup file `vitest.setup.ts`, default include pattern, and `e2e/**` excluded (Vitest's default include also matches the Playwright `*.spec.ts` files).
- `playwright.config.ts`: specs in `e2e/**/*.spec.ts`, one worker, the system Chrome (`/usr/bin/google-chrome`, override with `RISU_CHROME`; no browser download), `baseURL` `http://localhost:5201`. `globalSetup` is `util/playwright/globalSetup.mjs`, which starts one isolated stack per run.
- `util/playwright/stack.mjs`: `startStack({ serverPort, vitePort, serverEnv })` runs `server/src/main.ts` in a fresh temporary working directory (the server takes `save/` from `process.cwd()`, so the store starts empty and the repository `save/` is never touched) and the Vite dev server with `RISU_DEV_SERVER` pointing at it (`serverEnv` adds to the server's environment only, e.g. `NODE_OPTIONS` with a check's `--import` preload; without one the server gets a `fetch` egress tripwire, `deniedEgress()`); `isolateContext(context)` keeps a browser context's HTTP requests on local hosts and `unexpectedEgress` filters the expected blocks (CDN stylesheets, the hub listing). `util/playwright/offline.sh <command>` runs a check in a user and network namespace with loopback only (`unshare -rn`): the boundary that keeps the stack, the browser, and the mocks off public services, whatever the transport; `stop()` ends both and deletes the directory. `openApp(page, baseURL)` answers the node-password prompts and waits for `loadedStore`. Page code reaches app modules with `await import("/src/...")`, which is the same module instance the app uses; a two-client check opens a second browser context (tabs of one context share `localStorage`).
- `util/playwright/capturePhase3Fixtures.mjs`: captures the Phase 3 pre-phase fixtures in `src/ts/storage/tests/fixtures/phase3/` (see its README).
- `util/playwright/captureTokenizerIds.mjs` and `util/playwright/capturePhase5Baseline.mjs`: capture the Phase 5 browser-path fixtures in `server/src/tests/fixtures/tokens/` (per-family token ids) and `server/src/tests/fixtures/baseline/` (preview prompts, `ParseMarkdown` HTML, `encode` routing, lore regex, the `igp` send; see its README for how randomness, time, the viewport, settings, and the network were controlled). `capturePhase5Baseline.mjs` drives the browser path the Phase 5 cutover removed (it imports `src/ts/process/scripts.ts`), so it runs only on a checkout at `219dfb51` or earlier.
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

Web:

- There is no mobile (Capacitor) build. Installation is only through the PWA manifest.
- `public/sw.js`: Cache Storage `risuCache`. Routes `/sw/check`, `/sw/img/<hex>`, `/sw/register`, `/sw/init`, `/sw/share/{character,preset,module}`. Registered by `bootstrap.ts:registerSw`, read by `globalApi.getFileSrc` and `characterCards.characterURLImport`.
- `public/manifest.json`: PWA manifest. `file_handlers` for `.charx`, `.risup`, `.risum` go through `launchQueue` to `characterURLImport`. `share_target` posts to `/receive-files/`, which has no in-repo handler.
- `util/risuUserscript.user.js`: exposes `GM_fetch` as `unsafeWindow.userScriptFetch`, which `globalFetch` uses when present.

## Flows

- Production: `pnpm build` produces `dist/`, which only the Hono self-host server (`pnpm runserver`, `server/src/`) or Docker serves. Served any other way (static hosting), the client shows the `NodeServerRequired` notice.
- Development: `pnpm runserver` plus `pnpm dev`.
- There is no desktop build. The Tauri shell (`src-tauri/`), its `@tauri-apps/*` packages, the updater, and the Python llama.cpp sidecar were removed.

## State

- Version: `version.json` and `src/ts/storage/database.svelte.ts` `appVer` (marked `APP_VERSION_POINT`). `getVersionString` appends `appSubVer` or the nightly label.

## Coupling

- The service worker URL conventions are coupled to `bootstrap.ts`, `globalApi.getFileSrc`, and `characterCards.characterURLImport`.

## Invariants

- Bump the version in both places. `package.json` `version` is not the app version.
- The service worker paths (`/sw/img` with hex paths, `/sw/share/*`) are a contract with three consumers.

## Recipes

- Change the build: `vite.config.ts`, plus the consumers of any env var (`bootstrap.ts`). Verify with `pnpm check`, `pnpm test`, `pnpm build`.
- Change the service worker: `public/sw.js`, `bootstrap.ts:registerSw`, `globalApi.getFileSrc`, `characterURLImport`, and `manifest.json`.
- Release: bump `version.json` and `appVer`.

## Tests

Run everything with `pnpm test` (Vitest, happy-dom). At the end of Phase 1 there are 50 files and 485 tests (3 skipped), all passing, in about 8 s. `pnpm check` reports 0 errors in about 25 s.

Test inventory:

| Area             | Test files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GUI              | `src/lib/UI/GUI/{guiRendering,SecretInput}.test.ts`, `src/lib/UI/NanoGPTDashboard.test.ts` (with the `src/lib/UI/tests/reactiveProps.svelte.ts` helper)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Parser           | `src/ts/parser/tests/cbs/{conditionals,escapes,loop,strings}.test.ts`, `chatML.test.ts`, `chatVar.svelte.test.ts`, `trimMarkdownStyle.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Process          | `files/tests/inlays.test.ts`, `mcp/risuaccess/tests/modules.test.ts` (with `__snapshots__`), `request/tests/additionalParams.test.ts`, `request/openAI/requests.responses.test.ts` (against the test-only `request/tests/oracle/`), `ttsHooks.test.ts`, `ttsOpenAI.test.ts`, `memory/hypaV3Presets.test.ts`, `memory/memoryOracle.test.ts` (the tab's HypaV3 against `server/src/tests/fixtures/memory/algorithms.json`)                                                                                                                                                                                                                                                                    |
| Storage and core | `src/ts/chatLoadPages.test.ts`, `src/ts/sourcemap.test.ts`, `src/ts/tokenizer.test.ts`, `src/ts/storage/{autoStorage,database.setDatabase}.test.ts`, `src/ts/storage/tests/{resourceSync,resourceSyncSections,resourceSyncSecrets,resourceSyncChats,resourceSyncUnload,llmSecrets,resourceClient,browserLocalImport,nodeStorage,bootSnapshot,presetIds}.test.ts` (with the `fakeResourceServer.ts`, `storeBackedServer.ts`, and `serverKinds.ts` helpers)                                                                                                                                                                                                                                   |
| Plugins          | `src/ts/plugins/{plugins,pluginSafeClass}.test.ts`, `src/ts/plugins/apiV3/{pluginStorage,hostApi,permissionStore,permissions}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Backup           | `src/ts/drive/backuplocal.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Server           | `server/src/tests/*.test.ts` (`// @vitest-environment node`; see `self-host-server.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Test harness     | `vitest.setup.test.ts` (happy-dom `nodeName` shim contract and the accessors DOMPurify captures)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Network          | `src/ts/network/{localNetwork,auxFetch,generationJobs,jobChannel,jobChannelBarrier}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Media            | `src/ts/media/tests/imageType.test.ts`, `src/ts/media/compressImage/tests/compressImage.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Translator       | `src/ts/translator/{edittransRegex,presets,presetsCodec}.test.ts`, `src/lib/Setting/Pages/Language/TranslatorPresetSettings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| End-to-end       | `e2e/idleReload.spec.ts` (`pnpm test:e2e`: a fresh boot creates only `modules` and `plugins`; an idle reload writes nothing), `e2e/presetSelection.spec.ts` (edit then switch then reload; per-client and per-tab preset selection), `e2e/personaBinding.spec.ts` (a persona's icon change keeps its chat binding; per-client persona selection), `e2e/serverTransform.spec.ts` (the server script transform in a mounted chat: streaming modes, locked rows, Re-render, a chat switch), `e2e/transformGolden.spec.ts` (the script-transform golden against `markdown.json`), `e2e/terminalNotice.spec.ts` (the restore notice: no toast, no dismissal by other alerts or keys, OK reloads) |

- No automated tests for the service worker, the manifest, or the userscript. Verify those manually.
- Browser checks use Playwright against the stack above: plain `playwright-core` scripts in `util/playwright/` for captures and one-off observations, `@playwright/test` specs in `e2e/` for repeatable checks (`pnpm test:e2e`). `playwright.config.ts`, `e2e/`, and `util/playwright/` are outside `tsconfig.json`'s include, so `pnpm check` does not type-check them.

## Known Hazards

- The service-worker share branch calls `registerCache` with a relative URL, and `new URL(urlr)` has no base (unverified).
