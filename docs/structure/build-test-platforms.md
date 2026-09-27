# Build, Test Harness, Mobile (Capacitor), Service Worker, Release

## Scope
- Owns:
  - package scripts,
  - Vite, Vitest, and TypeScript config,
  - the test inventory,
  - the Capacitor config,
  - the PWA service worker and manifest,
  - the userscript bridge,
  - version bumping,
  - repo dotfiles.
- Paths:
  - Root config: `package.json`, `vite.config.ts`, `vitest.config.ts`, `vitest.setup.ts`, `tsconfig.json`, `tsconfig.node.json`, `capacitor.config.ts`, `version.json`, `t.py`
  - Dotfiles: `.gitignore`, `.ignore`, `.gitattributes`, `.npmrc`, `.vscode/`
  - `public/sw.js`, `public/manifest.json`
  - `util/risuUserscript.user.js`
  - `resources/` (app icons and splash images)
- Not here:
  - `globalApi.svelte.ts` `fetchNative` → `global-api.md`.
  - The self-host server → `self-host-server.md`.

## Files
`package.json` scripts:

| Script | Command | Use |
|---|---|---|
| `dev` | `vite` | dev server |
| `build` | `vite build --sourcemap` | web build |
| `buildsite` | `vite build --outDir dist` | site build |
| `preview` | `vite preview` | preview the build |
| `check` | `svelte-check --tsconfig ./tsconfig.json` | type check |
| `test` | `vitest run` | tests |
| `runserver` | `node server/node/server.cjs` | self-host server |
| `hono:build` | build + Hono postbuild | Hono skeleton |
| `sync`, `electron` | reference a missing `electron/` directory | dead |

- There is no `format` script, no Prettier config, and no `.prettierignore`.

Config files:
- `vite.config.ts`:
  - Plugins: Svelte, Tailwind (`@tailwindcss/vite`), `vite-plugin-wasm`, conditional `@rollup/plugin-strip`.
  - Dev server is fixed at port 5174 with `strictPort`, listening on `0.0.0.0`.
  - `envPrefix` is Vite's default (`VITE_`). `build.minify` is `oxc`.
  - Alias `src` → `/src`. Workers are built as `es`.
  - Neither `define` nor `manualChunks` is set.
- `vitest.config.ts`: Svelte plugin, `src` alias, browser resolve conditions, `happy-dom`, setup file `vitest.setup.ts`, default include pattern.
- `vitest.setup.ts`: mocks KaTeX and sets `globalThis.safeStructuredClone` to a JSON clone.
- `tsconfig.json`: includes `src/**/*` and `public/sw.js`.

Environment variables:
- `VITE_RISU_NIGHTLY_BUILD`, `VITE_RISU_BUILD_TIME`.
- `VITE_RISU_LEGAL_CONFIGURED`.
- Ad variables.

Web and mobile:
- `capacitor.config.ts`: `co.aiclient.risu`, `webDir: dist`, Android HTTPS scheme. The repo has no Capacitor dependencies or scripts.
- `public/sw.js`: Cache Storage `risuCache`. Routes `/sw/check`, `/sw/img/<hex>`, `/sw/register`, `/sw/init`, `/sw/share/{character,preset,module}`. Registered by `bootstrap.ts:registerSw`, read by `globalApi.getFileSrc` and `characterCards.characterURLImport`.
- `public/manifest.json`: PWA manifest. `file_handlers` for `.charx`, `.risup`, `.risum` go through `launchQueue` to `characterURLImport`. `share_target` posts to `/receive-files/`, which has no in-repo handler.
- `util/risuUserscript.user.js`: exposes `GM_fetch` as `unsafeWindow.userScriptFetch`, which `globalFetch` uses when present.

## Flows
- Web: `pnpm dev` or `pnpm build` produces `dist/`, which is served statically, by `server.cjs`, or by Docker.
- There is no desktop build. The Tauri shell (`src-tauri/`), its `@tauri-apps/*` packages, the updater, and the Python llama.cpp sidecar were removed.

## State
- Version: `version.json` and `src/ts/storage/database.svelte.ts` `appVer` (marked `APP_VERSION_POINT`). `getVersionString` appends `appSubVer`, nightly, or `(Stable)`.

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
Run everything with `pnpm test` (Vitest, happy-dom). At commit `1494fb83` there are 24 files and 230 tests, all passing, in about 5 s. `pnpm check` reports 0 errors in about 20 s.

Test inventory:

| Area | Test files |
|---|---|
| GUI | `src/lib/UI/GUI/guiRendering.test.ts` |
| Parser | `src/ts/parser/tests/cbs/{conditionals,escapes,loop,strings}.test.ts`, `chatML.test.ts`, `chatVar.svelte.test.ts`, `trimMarkdownStyle.test.ts` |
| Process | `coldstorageData.test.ts`, `files/tests/inlays.test.ts`, `mcp/risuaccess/tests/modules.test.ts` (with `__snapshots__`), `request/tests/additionalParams.test.ts`, `request/openAI/requests.responses.test.ts`, `scriptings.test.ts`, `ttsHooks.test.ts` |
| Storage and core | `src/ts/chatLoadPages.test.ts`, `src/ts/sourcemap.test.ts`, `src/ts/tokenizer.test.ts` |
| Network | `src/ts/network/{localNetwork,proxyJobWs}.test.ts` |
| Media | `src/ts/media/tests/imageType.test.ts`, `src/ts/media/compressImage/tests/compressImage.test.ts` |
| Translator | `src/ts/translator/{edittransRegex,presets}.test.ts` |

- No automated tests for Capacitor, the service worker, the manifest, or the userscript. Verify those manually.

## Known Hazards
- The service-worker share branch calls `registerCache` with a relative URL, and `new URL(urlr)` has no base (unverified).
- `package.json` `sync`/`electron` point to a missing `electron/` directory. `t.py` is an unrelated toy.
