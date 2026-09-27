# App Shell

## Scope

- Owns: boot sequence, top-level screen selection, global stores, platform flags, hotkeys, DOM observers, `Mutex`.
- Paths: `index.html`, `src/main.ts`, `src/preload.ts`, `src/App.svelte`, `src/ts/{bootstrap,stores.svelte,platform,polyfill,hotkey,defaulthotkeys,observer.svelte,mutex}.ts`, `src/types.d.ts`, `src/vite-env.d.ts`, `src/lib/UI/MainMenu.svelte`, `src/lib/UI/Title.svelte`.
- Not here: DB shape and migrations → `persistence.md`. The save loop and `globalFetch` → `global-api.md`. Chat UI below `ChatScreen` → `ui-theming.md`.

## Files

- `src/main.ts`: entry. Imports `./ts/polyfill` and the database side effects, then `preLoadCheck()`, `mount(App)`, `loadData()` (not awaited), `initHotkey()`, and removes `#preloading`.
- `src/preload.ts` `preLoadCheck`: pre-mount step that sets `localStorage.mainpage`. On `isWeb` it registers `beforeunload`.
- `src/App.svelte`: the "router" (ordered `{#if}` chain), plus drag/drop import, overlays (alerts, popups, modals), and keep-alive audio.
- `src/ts/bootstrap.ts`:
  - `loadData`: `forageStorage` DB load, then migrations, plugins, theme, `loadedStore = true`, then services such as `saveDb`.
  - `checkNewFormat`: legacy data repair.
  - `registerSw`: service worker.
- `src/ts/stores.svelte.ts`: all global UI stores plus the `DBState` rune (see State).
- `src/ts/platform.ts`: `isNodeServer`, `isWeb`, `isMobile`, `isFirefox`, `isIOS()`, `getRisuEnvironmentLabel`, `getDetailedOSLabel`, `isInStandaloneMode` (unused).
- `src/ts/polyfill.ts`: `safeStructuredClone` (native `structuredClone`, then an `rfdc` fallback), plus `Buffer` and stream polyfills and the mobile drag/drop polyfill.
- `src/vite-env.d.ts`: ambient declarations for the globals `Buffer`, `safeStructuredClone`, and `userScriptFetch`.
- `src/types.d.ts`: the `DeepPartial<T>` utility type only.
- `src/ts/hotkey.ts`:
  - `initHotkey`: keydown dispatch switch.
  - `hotkeyMatches`.
- `src/ts/defaulthotkeys.ts`: the `Hotkey` type and `defaultHotkeys`.
- `src/ts/observer.svelte.ts`:
  - `startObserveDom`: idempotent. Adds one `document` `contextmenu` delegate (Copy/Download menu for `x-hl-lang` code blocks) and a `MutationObserver` on `document.body` that syncs BGM from `risu-ctrl="bgm___<volume|auto>___<src>"` markers.
  - BGM: one track at a time. When nothing is playing, it starts the first marker in document order (the newest message, since the chat body is column-reversed). A playing track keeps playing while its marker stays in the DOM, even if a newer marker appears, and replays on `ended`. It stops `BGM_STOP_GRACE_MS` (1 s) after its marker is gone.
  - BGM failures: an autoplay block (`NotAllowedError`) pauses all BGM until the next activating `pointerup`/`keydown` (touch grants activation only on release). A source or media error skips only that marker, so another marker can still play; it is not retried on gestures, only after the marker has been missing from the DOM for more than 1 s and appears again.
  - `registerClaudeObserver`: Claude cache keep-alive pings, called from `process/request/anthropic.ts`.
- `src/ts/mutex.ts` `Mutex`: FIFO lock used by the scripting engines. `runExclusive` must keep its `finally` release.
- `src/lib/UI/MainMenu.svelte`: home screen. Switches to `RealmMain` via `OpenRealmStore`. Renders `hubAdditionalHTML` with `{@html}`.
- `src/lib/UI/Title.svelte`: seasonal logo and mini-game. Only used by MainMenu.

## Flows

Boot:

1. `index.html` provides `#app` and a `#preloading` overlay, then loads `/src/main.ts`.
2. `main.ts` mounts `App` before the DB is loaded. `App` shows the loading branch while `$loadedStore` is false.
3. `bootstrap.ts:loadData` loads the database: `forageStorage.Init()` (`AutoStorage`), local load with backup fallback, `registerSw`, then `characterURLImport`.
4. Common tail of `loadData`:
   1. `loadPlugins`.
   2. `checkNewFormat`, which ends in `setDatabase`.
   3. Theme functions: `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, `updateGuisize`.
   4. `loadedStore.set(true)` and `selectedCharID.set(-1)`.
   5. Observers, ID assignment, `registerModelDynamic`, `saveDb()` (exactly once), `moduleUpdate`, `cleanLegacyAccountData`. There is no boot-time asset cleanup: orphaned `assets/*` and `remotes/*` files are never purged automatically.

Screen selection. `App.svelte` checks these in order:

1. Legal/config and April Fools branches.
2. Loading.
3. `CustomGUISettingMenuStore`.
4. `!DBState.db.didFirstSetup` → `WelcomeRisu`.
5. `$settingsOpen` → `Settings`.
6. Otherwise `Sidebar` + `ChatScreen`.

Inside `DefaultChatScreen.svelte`:

- `$selectedCharID < 0 && $PlaygroundStore === 0` → `MainMenu`.
- `$PlaygroundStore > 0` → lazy `PlaygroundMenu`.
- Otherwise the chat.

## State

All of these live in `src/ts/stores.svelte.ts`.

- DB: `DBState` = `$state({db})`, initially an empty cast. `LoadingStatusState`.
- Navigation:
  - `selectedCharID`: `-1` means home.
  - `settingsOpen`, `SettingsMenuIndex`.
  - `sideBarStore`, `DynamicGUI`.
  - `PlaygroundStore`, `OpenRealmStore`, `RealmInitialOpenChar`.
  - `CharConfigSubMenu`, `botMakerMode`.
- Reload signals:
  - `ReloadGUIPointer`: its subscriber clears `ReloadChatPointer` and calls `resetScriptCache`.
  - `ReloadChatPointer`.
  - `selIdState`: rune mirror of `selectedCharID`.
- Overlays: `alertStore`, `popupStore`, `popUpEditorStore`, `easyPanelStore`, `irisStore`, `bookmarkListOpen`, `hypaV3ModalOpen`, `hypaV3ProgressStore`, `customSideBarConfigDialogStore`, `QuickSettings`.
- Plugin extension arrays (runes): `additionalSettingsMenu`, `additionalFloatingActionButtons`, `additionalHamburgerMenu`, `additionalChatMenu`, `chatPanelStore`, `bodyIntercepterStore`. Types are `MenuDef` and `ChatPanelDef`.
- Misc: `CustomCSSStore` (its subscriber injects CSS with `innerHTML`), `SafeModeStore`, `CharEmotion`, `ScrollToMessageStore`, `hotReloading`, `disableHighlight`.
- Root `$effect`: mirrors `selectedCharID` into `selIdState` and reruns `moduleUpdate` when module, chat, or background dependencies change.

## Coupling

- `stores.svelte.ts` is imported almost everywhere, with the highest fan-out in the repo. Changing a store's semantics affects the UI, process, plugins, and sync code.
- `bootstrap.ts` depends on storage, `globalApi.svelte.ts`, plugins, model registry, modules, and observers.
- Platform flags are consumed by storage, network, drive, cards, parser, translator, and settings.

## Invariants

- Do not flip `loadedStore` to true before `setDatabase`, `checkNewFormat`, and theme setup finish. `App` assumes `DBState.db` is normalized after that point. When `loadData` fails it only calls `alertError`, and the loading screen stays up.
- `selectedCharID === -1` is the home sentinel. Components index `DBState.db.characters[$selectedCharID]` whenever it is nonnegative.
- Call `saveDb()` only once, from `loadData`. It installs effects and runs an infinite loop.
- `isWeb` means production `risuai.xyz` only. localhost and dev runs are not `isWeb`.
- `isNodeServer` depends on `server/node/server.cjs` injecting `globalThis.__NODE__ = true` into `index.html`.
- New hotkey actions need:
  - an entry in `defaultHotkeys`,
  - a branch in the `initHotkey` dispatch switch,
  - a check that `setDatabase` merges new default actions into saved hotkeys.
- `safeStructuredClone` is a global installed by `polyfill.ts`, which must stay the first import in `main.ts`.

## Recipes

- Add a top-level screen or modal:
  1. Add a store in `stores.svelte.ts`.
  2. Add its branch or overlay in `App.svelte`, respecting the branch order.
  3. Set the store from the caller.
  4. Verify with `pnpm check` and a fresh load.
- Change startup:
  - Ordering: `main.ts`.
  - Pre-mount browser behavior: `preload.ts`.
  - Data and platform sequencing: `bootstrap.ts:loadData`.
  - Keep the `loadedStore` transition intact.
- Add a platform-specific behavior:
  1. Add or adjust the flag in `platform.ts`.
  2. Update every consumer.
  3. Keep the Node and plain-browser branches working.
- Add a hotkey: `defaulthotkeys.ts`, `hotkey.ts:initHotkey`, `database.svelte.ts:setDatabase` (merge behavior).

## Tests

- None cover boot, screen precedence, platform detection, hotkeys, `registerClaudeObserver`, or `Mutex`.
- `src/ts/observer.test.ts` covers `startObserveDom` under happy-dom with an `Audio` stub and fake timers: BGM marker parsing, selection, grace stop, failure and autoplay retry policy, and the delegated code-block menu. Mutation records are delivered with `takeRecords()` because happy-dom's own timer is not faked.
- Some tests mock `stores.svelte` and `platform` (parser tests, `scriptings.test.ts`, `requests.responses.test.ts`). They exercise consumers, not these modules.

## Known Hazards

- BGM stop detection is marker-based. If a message re-render keeps its BGM marker out of the DOM for more than 1 s (for example a slow re-parse), the track stops and restarts from the beginning.
- `isInStandaloneMode` has no consumers. `bootstrap.ts` recomputes standalone mode locally before calling `navigator.storage.persist`.
