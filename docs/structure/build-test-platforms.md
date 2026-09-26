# Build, Test Harness, Desktop (Tauri), Mobile (Capacitor), Service Worker, Release

## Scope
- Owns:
  - package scripts,
  - Vite, Vitest, and TypeScript config,
  - the test inventory,
  - the Tauri shell (Rust commands, capabilities, the Python llama.cpp sidecar),
  - the Capacitor config,
  - the PWA service worker and manifest,
  - the userscript bridge,
  - version bumping,
  - repo dotfiles.
- Paths:
  - Root config: `package.json`, `vite.config.ts`, `vitest.config.ts`, `vitest.setup.ts`, `tsconfig.json`, `tsconfig.node.json`, `capacitor.config.ts`, `version.json`, `t.py`
  - Dotfiles: `.gitignore`, `.ignore`, `.gitattributes`, `.npmrc`, `.vscode/`
  - `src-tauri/**` (skip `icons/`)
  - `public/sw.js`, `public/manifest.json`
  - `util/risuUserscript.user.js`
  - `resources/` (app icons and splash images)
- Not here:
  - `globalApi.svelte.ts` `fetchNative` (the Tauri streaming caller) → `global-api.md`.
  - The self-host server → `self-host-server.md`.

## Files
`package.json` scripts:

| Script | Command | Use |
|---|---|---|
| `dev` | `vite` | dev server |
| `build` | `vite build --sourcemap` | web build |
| `tauribuild` | `vite build` | used by Tauri |
| `buildsite` | `vite build --outDir dist` | site build |
| `preview` | `vite preview` | preview the build |
| `check` | `svelte-check --tsconfig ./tsconfig.json` | type check |
| `test` | `vitest run` | tests |
| `tauri` | `tauri` | Tauri CLI |
| `runserver` | `node server/node/server.cjs` | self-host server |
| `hono:build` | build + Hono postbuild | Hono skeleton |
| `sync`, `electron` | reference a missing `electron/` directory | dead |

- There is no `format` script, no Prettier config, and no `.prettierignore`.

Config files:
- `vite.config.ts`:
  - Plugins: Svelte, Tailwind (`@tailwindcss/vite`), `vite-plugin-wasm`, conditional `@rollup/plugin-strip`.
  - Dev server is fixed at port 5174 with `strictPort` (Tauri depends on this).
  - `envPrefix` is `['VITE_', 'TAURI_']`.
  - Alias `src` → `/src`. Workers are built as `es`.
  - Neither `define` nor `manualChunks` is set.
- `vitest.config.ts`: Svelte plugin, `src` alias, browser resolve conditions, `happy-dom`, setup file `vitest.setup.ts`, default include pattern.
- `vitest.setup.ts`: mocks KaTeX and sets `globalThis.safeStructuredClone` to a JSON clone.
- `tsconfig.json`: includes `src/**/*` and `public/sw.js`.

Environment variables:
- `VITE_RISU_LITE`: `TRUE` enables Lite.
- `VITE_RISU_NIGHTLY_BUILD`, `VITE_RISU_BUILD_TIME`.
- `VITE_RISU_LEGAL_CONFIGURED`.
- Ad variables.

Tauri (`src-tauri/`):
- `tauri.conf.json`:
  - `beforeDevCommand: pnpm dev`, `beforeBuildCommand: pnpm tauribuild`, `frontendDist: ../dist`.
  - Bundles `src-python/*`.
  - File associations for `.risum`, `.risup`, `.charx`.
  - Updater, deep link, `version`.
  - `csp: null`.
- `capabilities/desktop.json`: desktop defaults for updater, process, shell, HTTP, and deep link.
- `capabilities/migrated.json`: broad `main`-window permissions. Covers filesystem scopes, dialogs, HTTP to any `http(s)` URL, shell spawn of `node`/`npm`/`npx`/`docker`/`uvx` with any arguments (used by MCP `stdio:`), OS, process, and updater.
- `src/main.rs`: every `#[tauri::command]` plus plugin initialization.

  | Command | Status |
  |---|---|
  | `streamed_fetch` | used by `fetchNative`; emits `streamed_fetch` events `headers`/`chunk`/`end`, bodies base64 |
  | `install_python`, `install_pip`, `post_py_install`, `install_py_dependencies`, `run_py_server` | used by `process/models/local.ts`; Windows-only in practice |
  | `native_request`, `check_auth`, `check_requirements_local`, `oauth_login`, `greet` | no frontend caller |

- `src-python/main.py`: FastAPI plus llama-cpp, with `/llamacpp` and `/llamacpp/tokenize`. Authenticates with the `x-risu-auth` header against a `key.txt` located next to the Python executable.
- `src-python/run.py`: alternate launcher on port 8912. Tauri itself launches on port 10026.
- `src/mainx.txt`, `key.txt`, `.cargo/config.toml`: legacy or empty.

Web and mobile:
- `capacitor.config.ts`: `co.aiclient.risu`, `webDir: dist`, Android HTTPS scheme. The repo has no Capacitor dependencies or scripts.
- `public/sw.js`: Cache Storage `risuCache`. Routes `/sw/check`, `/sw/img/<hex>`, `/sw/register`, `/sw/init`, `/sw/share/{character,preset,module}`. Registered by `bootstrap.ts:registerSw`, read by `globalApi.getFileSrc` and `characterCards.characterURLImport`.
- `public/manifest.json`: PWA manifest. `file_handlers` for `.charx`, `.risup`, `.risum` go through `launchQueue` to `characterURLImport`. `share_target` posts to `/receive-files/`, which has no in-repo handler.
- `util/risuUserscript.user.js`: exposes `GM_fetch` as `unsafeWindow.userScriptFetch`, which `globalFetch` uses when present.

## Flows
- Web: `pnpm dev` or `pnpm build` produces `dist/`, which is served statically, by `server.cjs`, or by Docker.
- Desktop: `pnpm tauri dev` or `pnpm tauri build` runs Vite, then the Rust shell. Deep links and opened files go to `characterURLImport`.
- Local GGUF model: `process/models/local.ts` runs the install commands, starts `run_py_server` (Uvicorn on port 10026), then calls `tokenizeGGUFModel`/`/llamacpp`.

## State
- Version: `version.json`, `src-tauri/tauri.conf.json` `version`, and `src/ts/storage/database.svelte.ts` `appVer` (marked `APP_VERSION_POINT`). `getVersionString` appends `appSubVer`, nightly, or `(Stable)`.

## Coupling
- `main.rs` command names, argument names, and event schemas are coupled to `globalApi.svelte.ts` and `process/models/local.ts`.
- `tauri.conf.json` is coupled to the package scripts, the port, `dist`, and `src-python`.
- The service worker URL conventions are coupled to `bootstrap.ts`, `globalApi.getFileSrc`, and `characterCards.characterURLImport`.

## Invariants
- Keep the Vite port at 5174 with `strictPort`, matching `tauri.conf.json` `devUrl`.
- Keep the `streamed_fetch` event names, ID padding, ordering, and base64 encoding in sync between Rust and `fetchNative`.
- Frontend `pyPath` maps to Rust `py_path` through Tauri's argument case conversion. Rename both sides together.
- Do not broaden or narrow the capabilities casually. They gate MCP `stdio:`, native HTTP, and filesystem access.
- Bump the version in all three places. `package.json` `version` is not the app version.
- The service worker paths (`/sw/img` with hex paths, `/sw/share/*`) are a contract with three consumers.

## Recipes
- Change the build: `vite.config.ts`, plus the consumers of any env var (`lite.ts`, `bootstrap.ts`). Verify with `pnpm check`, `pnpm test`, `pnpm build`.
- Add a Tauri command:
  1. Add the Rust function to `main.rs` and to `generate_handler!`.
  2. Add the frontend `invoke` caller.
  3. Update capabilities only if a plugin permission is needed.
  4. Verify with `pnpm tauri build`.
- Change native streaming: `main.rs:streamed_fetch` plus the `fetchNative` listener and reassembly.
- Change the service worker: `public/sw.js`, `bootstrap.ts:registerSw`, `globalApi.getFileSrc`, `characterURLImport`, and `manifest.json`.
- Release: bump `version.json`, `tauri.conf.json`, and `appVer`.

## Tests
Run everything with `pnpm test` (Vitest, happy-dom). At commit `1494fb83` there are 24 files and 230 tests, all passing, in about 5 s. `pnpm check` reports 0 errors in about 20 s.

Test inventory:

| Area | Test files |
|---|---|
| GUI | `src/lib/UI/GUI/guiRendering.test.ts` |
| Parser | `src/ts/parser/tests/cbs/{conditionals,escapes,loop,strings}.test.ts`, `chatML.test.ts`, `chatVar.svelte.test.ts`, `trimMarkdownStyle.test.ts` |
| Process | `coldstorageData.test.ts`, `files/tests/inlays.test.ts`, `mcp/risuaccess/tests/modules.test.ts` (with `__snapshots__`), `request/tests/additionalParams.test.ts`, `request/openAI/requests.responses.test.ts`, `scriptings.test.ts`, `ttsHooks.test.ts` |
| Storage and core | `src/ts/storage/remoteSaveCleanup.test.ts`, `src/ts/chatLoadPages.test.ts`, `src/ts/sourcemap.test.ts` |
| Network | `src/ts/network/{localNetwork,proxyJobWs}.test.ts` |
| Media | `src/ts/media/tests/imageType.test.ts`, `src/ts/media/compressImage/tests/compressImage.test.ts` |
| Translator | `src/ts/translator/{edittransRegex,presets}.test.ts` |

- No automated tests for Tauri, Rust, Python, Capacitor, the service worker, the manifest, or the userscript. Verify those manually.

## Known Hazards
- `install_python` returns early on non-Windows, which makes its later branches unreachable.
- The two sidecar launch paths read and write `key.txt` in different places (`run.py` uses cwd, `main.py` uses the executable's directory).
- The service-worker share branch calls `registerCache` with a relative URL, and `new URL(urlr)` has no base (unverified).
- `package.json` `sync`/`electron` point to a missing `electron/` directory. `t.py` is an unrelated toy.
