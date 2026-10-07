# App Shell

## Scope

- Owns: boot sequence, top-level screen selection, global stores, platform flags, hotkeys, DOM observers, `Mutex`.
- Paths: `index.html`, `src/main.ts`, `src/boot.ts`, `src/lib/Others/NodeServerRequired.svelte`, `src/App.svelte`, `src/ts/{bootstrap,stores.svelte,platform,polyfill,hotkey,defaulthotkeys,observer.svelte,mutex}.ts`, `src/types.d.ts`, `src/vite-env.d.ts`, `src/lib/UI/MainMenu.svelte`, `src/lib/UI/Title.svelte`.
- Not here: DB shape and migrations → `persistence.md`. The save loop and `globalFetch` → `global-api.md`. Chat UI below `ChatScreen` → `ui-theming.md`.

## Files

- `src/main.ts`: entry. Imports `./ts/polyfill` and `core-js`, registers the `vite:preloadError` alert, then branches on `isNodeServer`: true → dynamic `import("./boot")` and `boot()`; false → mounts `NodeServerRequired` and removes `#preloading`. The app graph (App, bootstrap, stores, DB) is never imported without the server.
- `src/boot.ts` `boot`: imports the database side effects, `mount(App)`, `loadData()` (not awaited), `initHotkey()`, and removes `#preloading`.
- `src/lib/Others/NodeServerRequired.svelte`: the notice shown when the client is opened without the self-host server (static hosting, a bare `vite build` output). English only (`language.nodeServerRequiredTitle`/`Desc`), since `changeLanguage` runs only after the DB loads.
- `src/App.svelte`: the "router" (ordered `{#if}` chain), plus drag/drop import, overlays (alerts, popups, modals), and keep-alive audio.
- `src/ts/bootstrap.ts`:
  - `loadData`: the server resources are read and installed into the records, then maintenance, theme, `startResourceSync` (the save adapter), the browser-local import, plugins, `loadedStore = true`, then services.
  - `installBootRecords`: installs the resource records into the settings and character records and the chat module (see `persistence.md`, Load); no whole-database object is built.
  - `maintainCharacters`: the boot's maintenance (the trash pruning, the character order); no character default.
  - `registerSw`: service worker.
- `src/ts/stores.svelte.ts`: all global UI stores (see State).
- `src/ts/platform.ts`: `isNodeServer` (read only by `main.ts`), `isMobile`, `isIOS()`, `getRisuEnvironmentLabel` (`node` or `node(dev)`), `getDetailedOSLabel`, `isInStandaloneMode` (unused).
- `src/ts/polyfill.ts`: `safeStructuredClone` (native `structuredClone`, then an `rfdc` fallback), plus `Buffer` and stream polyfills and the mobile drag/drop polyfill.
- `src/vite-env.d.ts`: ambient declarations for the globals `Buffer`, `safeStructuredClone`, and `userScriptFetch`.
- `src/types.d.ts`: the `DeepPartial<T>` utility type only.
- `src/ts/hotkey.ts`:
  - `initHotkey`: keydown dispatch switch.
  - `hotkeyMatches`: reads the hotkey only (a missing modifier flag is "not held"); it never writes the stored list.
  - `activeHotkeys`: the stored hotkeys without `scrollToActiveChar` while `enableScrollToActiveChar` is off (the dispatch and `HotkeySettings.svelte` read through it).
- `src/ts/defaulthotkeys.ts`: re-exports `defaultHotkeys` (declared in `shared/hotkeys.ts`) and the `Hotkey` type declared in `shared/settings.ts`.
- `src/ts/observer.svelte.ts`:
  - `startObserveDom`: idempotent. Adds one `document` `contextmenu` delegate (Copy/Download menu for `x-hl-lang` code blocks) and a `MutationObserver` on `document.body` that syncs BGM from `risu-ctrl="bgm___<volume|auto>___<src>"` markers.
  - BGM: one track at a time. When nothing is playing, it starts the first marker in document order (the newest message, since the chat body is column-reversed). A playing track keeps playing while its marker stays in the DOM, even if a newer marker appears, and replays on `ended`. It stops `BGM_STOP_GRACE_MS` (1 s) after its marker is gone.
  - BGM failures: an autoplay block (`NotAllowedError`) pauses all BGM until the next activating `pointerup`/`keydown` (touch grants activation only on release). A source or media error skips only that marker, so another marker can still play; it is not retried on gestures, only after the marker has been missing from the DOM for more than 1 s and appears again.
- `src/ts/mutex.ts` `Mutex`: FIFO lock. Its users were the browser scripting engines, removed at the Phase 5 cutover, so nothing in production imports it now. `runExclusive` must keep its `finally` release.
- `src/lib/UI/MainMenu.svelte`: home screen. Switches to `RealmMain` via `OpenRealmStore`. Renders `hubAdditionalHTML` with `{@html}`.
- `src/lib/UI/Title.svelte`: seasonal logo and mini-game. Only used by MainMenu.

## Flows

Boot:

1. `index.html` provides `#app` and a `#preloading` overlay, then loads `/src/main.ts`, which stops at the notice unless `__NODE__` was injected, and otherwise loads `boot.ts`.
2. `boot.ts:boot` mounts `App` before the DB is loaded. `App` shows the loading branch while `$loadedStore` is false.
3. `bootstrap.ts:loadData` loads the data: one `readKinds` of every resource kind with chat summaries (the first request prompts for the password on a new browser), `seedResources`/`seedChats`/`seedInlays`, `loadSelection`, `installBootRecords`, `registerSw`, then `characterURLImport`. A failed read only alerts; there is no local fallback.
4. Common tail of `loadData`:
   1. `maintainCharacters` (the trash pruning through `removeCharacters`, then `checkCharOrder`), and `initializeChats`.
   2. Theme functions: `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, `updateGuisize`.
   3. `startResourceSync()` (exactly once; starts the save adapter) and `watchRemoteRecords`: it drops the inlay caches whenever the adapter brought another tab's records in (`onRemoteRecordApplied` → `invalidateInlayCaches`).
   4. `importBrowserLocalData` (moves old browser-only data to the server), `loadPluginPermissions`, then `loadPlugins`. Plugins load after normalization and ID assignment (before Phase 1 they loaded first).
   5. `loadedStore.set(true)` and `selectCharacter(null)`.
   6. Observers, `registerModelDynamic`, `moduleUpdate`, `cleanLegacyAccountData`. There is no boot-time asset cleanup: orphaned `assets/*` files (including inlay blobs) are never purged automatically.

Screen selection. `App.svelte` checks these in order:

1. April Fools branch.
2. Loading.
3. `CustomGUISettingMenuStore`.
4. `!settings.ui.didFirstSetup` → `WelcomeRisu`.
5. `$settingsOpen` → `Settings`.
6. Otherwise `Sidebar` + `ChatScreen`.

Inside `DefaultChatScreen.svelte`:

- No selected character (`currentCharacter === undefined`) and `$PlaygroundStore === 0` → `MainMenu`.
- `$PlaygroundStore > 0` → lazy `PlaygroundMenu`.
- Otherwise the chat.

## State

All of these live in `src/ts/stores.svelte.ts`.

- `LoadingStatusState`.
- Navigation:
  - The selected character is not a store here: it is `selection.characterId` (`storage/selection.svelte.ts`: the selected `chaId` per tab, never stored, `null` at home), set with `selectCharacter(chaId)` and read as `selectedCharacter()`; `selectedIndex()` is its index in the list (a removed selected character selects home).
  - `settingsOpen`, `SettingsMenuIndex`.
  - `sideBarStore`, `DynamicGUI`.
  - `PlaygroundStore`, `OpenRealmStore`, `RealmInitialOpenChar`.
  - `CharConfigSubMenu`, `botMakerMode`.
- Reload signals:
  - `ReloadGUIPointer`: its subscriber clears `ReloadChatPointer` and calls `resetTransformEffects` (the script transform's applied emotions, `cbs-rendering.md`).
  - `ReloadChatPointer`.
- Overlays: `alertStore`, `terminalNotice` (`TerminalNotice.svelte`, a modal dialog above every other overlay), `popupStore`, `popUpEditorStore`, `easyPanelStore`, `irisStore`, `bookmarkListOpen`, `hypaV3ModalOpen`, `hypaV3ProgressStore`, `customSideBarConfigDialogStore`, `QuickSettings`.
- Plugin extension arrays (runes): `additionalSettingsMenu`, `additionalFloatingActionButtons`, `additionalHamburgerMenu`, `additionalChatMenu`, `chatPanelStore`, `bodyIntercepterStore`. Types are `MenuDef` and `ChatPanelDef`.
- Misc: `CustomCSSStore` (its subscriber injects CSS with `innerHTML`), `SafeModeStore`, `CharEmotion`, `ScrollToMessageStore`, `hotReloading`, `disableHighlight`.
- Root `$effect`: reruns `moduleUpdate` when module, chat, or background dependencies change.

## Coupling

- `stores.svelte.ts` is imported almost everywhere, with the highest fan-out in the repo. Changing a store's semantics affects the UI, process, plugins, and sync code.
- `bootstrap.ts` depends on storage, `globalApi.svelte.ts`, plugins, model registry, modules, and observers.
- `isNodeServer` is consumed only by `main.ts`. `isMobile`/`isIOS` are consumed by UI code.

## Invariants

- Do not flip `loadedStore` to true before `installBootRecords`, `maintainCharacters`, and theme setup finish. `App` assumes the records are installed after that point. When `loadData` fails it only calls `alertError`, and the loading screen stays up.
- No selected character is home. Components read the selected character as `const currentCharacter = $derived(selectedCharacter())` and the list as `characterList()`, never by an index; a handler that awaits captures the `chaId` first and finds the character again after the await.
- Call `startResourceSync()` only once, from `loadData`; it ignores a second call.
- `isNodeServer` depends on `server/src/app.ts` (`GET /` and `/index.html`) or the Vite dev plugin `risu-node-flag` injecting `globalThis.__NODE__ = true` into `index.html`. Keep everything the app needs behind the dynamic `boot.ts` import so the notice path initializes nothing.
- New hotkey actions need:
  - an entry in `defaultHotkeys`,
  - a branch in the `initHotkey` dispatch switch,
  - a check that the server's `hotkeys` normalizer merges new default actions into saved hotkeys.
- `safeStructuredClone` is a global installed by `polyfill.ts`, which must stay the first import in `main.ts` (before the `boot.ts` import).

## Recipes

- Add a top-level screen or modal:
  1. Add a store in `stores.svelte.ts`.
  2. Add its branch or overlay in `App.svelte`, respecting the branch order.
  3. Set the store from the caller.
  4. Verify with `pnpm check` and a fresh load.
- Change startup:
  - Server gate: `main.ts`.
  - Ordering: `boot.ts`.
  - Data and platform sequencing: `bootstrap.ts:loadData`.
  - Keep the `loadedStore` transition intact.
- Add a platform-specific behavior:
  1. Add or adjust the flag in `platform.ts`.
  2. Update every consumer.
  3. There is no browser-only runtime to keep working; do not reintroduce `isNodeServer` branches past `main.ts`.
- Add a hotkey: `shared/hotkeys.ts` (`defaultHotkeys`), `hotkey.ts:initHotkey`; the server `hotkeys` normalizer (`server/src/data/normalize/collections.ts`) merges a new built-in hotkey into stored lists by `action`. A hotkey gated by a setting is filtered by the readers (`activeHotkeys`), not removed from the list.

## Tests

- None cover boot, screen precedence, platform detection, hotkeys, or `Mutex`.
- `src/ts/observer.test.ts` covers `startObserveDom` under happy-dom with an `Audio` stub and fake timers: BGM marker parsing, selection, grace stop, failure and autoplay retry policy, and the delegated code-block menu. Mutation records are delivered with `takeRecords()` because happy-dom's own timer is not faked.
- Some tests mock `stores.svelte` and `platform` (the parser tests). They exercise consumers, not these modules.

## Known Hazards

- BGM stop detection is marker-based. If a message re-render keeps its BGM marker out of the DOM for more than 1 s (for example a slow re-parse), the track stops and restarts from the beginning.
- `isInStandaloneMode` has no consumers. `bootstrap.ts` recomputes standalone mode locally before calling `navigator.storage.persist`.
- A user-defined `send` hotkey clicks `.button-icon-send` without the popup-editor guard of the preset hotkeys, so it can send (and run `presetChain`) while a popup editor is open.
- The `ReloadGUIPointer` subscriber in `stores.svelte.ts` skips its first call: `subscribe` calls back at once while the module is still evaluating, and `stores.svelte.ts` and `parser/transformClient.ts` import each other, so that call could reach `resetTransformEffects` before `transformClient`'s bindings exist. Keep the skip while the cycle remains (`stores.importOrder.test.ts`).
