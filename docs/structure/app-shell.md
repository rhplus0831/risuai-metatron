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
  - `loadData`: `forageStorage` DB load, then migrations, plugins, theme, `makeColdData`, `loadedStore = true`, then services such as `saveDb`.
  - `checkNewFormat`: legacy data repair.
  - `registerSw`: service worker.
- `src/ts/stores.svelte.ts`: all global UI stores plus the `DBState` rune (see State).
- `src/ts/platform.ts`: `isNodeServer`, `isWeb`, `isMobile`, `isFirefox`, `isIOS()`, `getRisuEnvironmentLabel`, `getDetailedOSLabel`, `isInStandaloneMode` (unused).
- `src/ts/polyfill.ts`: `safeStructuredClone` (native `structuredClone`, then an `rfdc` fallback), plus `Buffer` and stream polyfills and the mobile drag/drop polyfill.
- `src/ts/hotkey.ts`:
  - `initHotkey`: keydown dispatch switch.
  - `hotkeyMatches`.
  - `initMobileGesture`: swipes.
- `src/ts/defaulthotkeys.ts`: the `Hotkey` type and `defaultHotkeys`.
- `src/ts/observer.svelte.ts`:
  - `startObserveDom`: an infinite 100 ms polling loop.
  - `registerClaudeObserver`: Claude cache keep-alive pings, called from `process/request/anthropic.ts`.
- `src/ts/mutex.ts` `Mutex`: FIFO lock used by the scripting engines. `runExclusive` must keep its `finally` release.
- `src/lib/UI/MainMenu.svelte`: home screen. Switches to `RealmMain` via `OpenRealmStore`. Renders `hubAdditionalHTML` with `{@html}`.
- `src/lib/UI/Title.svelte`: seasonal logo and mini-game. Only used by MainMenu.

## Flows
Boot:
1. `index.html` provides `#app` and a `#preloading` overlay, then loads `/src/main.ts`.
2. `main.ts` mounts `App` before the DB is loaded. `App` shows the loading branch while `$loadedStore` is false.
3. `bootstrap.ts:loadData` loads the database: `forageStorage.Init()` (`AutoStorage`), account or remote load, the Drive callback check (`checkDriverInit`), `registerSw`, then `characterURLImport`.
4. Common tail of `loadData`:
   1. `loadPlugins`.
   2. `checkNewFormat`, which ends in `setDatabase`.
   3. Theme functions: `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, `updateGuisize`.
   4. `MobileGUI` when `betaMobileGUI && innerWidth <= 800`.
   5. `await makeColdData`.
   6. `loadedStore.set(true)` and `selectedCharID.set(-1)`.
   7. Observers, ID assignment, `registerModelDynamic`, `saveDb()` (exactly once), `moduleUpdate`, storage cleanup, TOS.

Screen selection. `App.svelte` checks these in order:
1. Legal/config and April Fools branches.
2. Loading.
3. `CustomGUISettingMenuStore`.
4. `!DBState.db.didFirstSetup` → `WelcomeRisu`.
5. `$settingsOpen` → `Settings`.
6. `$MobileGUI` → `MobileHeader`/`MobileBody`/`MobileFooter`.
7. Otherwise `Sidebar` + `ChatScreen`.

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
  - `MobileGUI`, `MobileGUIStack`, `MobileSideBar`, `sideBarStore`, `DynamicGUI`.
  - `PlaygroundStore`, `OpenRealmStore`, `RealmInitialOpenChar`, `ShowRealmFrameStore`.
  - `CharConfigSubMenu`, `botMakerMode`.
- Reload signals:
  - `ReloadGUIPointer`: its subscriber clears `ReloadChatPointer` and calls `resetScriptCache`.
  - `ReloadChatPointer`.
  - `selIdState`: rune mirror of `selectedCharID`.
- Overlays: `alertStore`, `popupStore`, `popUpEditorStore`, `easyPanelStore`, `loadoutModalStore`, `irisStore`, `bookmarkListOpen`, `hypaV3ModalOpen`, `hypaV3ProgressStore`, `customSideBarConfigDialogStore`, `QuickSettings`, `pluginAlertModalStore`.
- Plugin extension arrays (runes): `additionalSettingsMenu`, `additionalFloatingActionButtons`, `additionalHamburgerMenu`, `additionalChatMenu`, `chatPanelStore`, `bodyIntercepterStore`. Types are `MenuDef` and `ChatPanelDef`.
- Misc: `CustomCSSStore` (its subscriber injects CSS with `innerHTML`), `SafeModeStore`, `CharEmotion`, `ScrollToMessageStore`, `hotReloading`, `disableHighlight`.
- Root `$effect`: mirrors `selectedCharID` into `selIdState` and reruns `moduleUpdate` when module, chat, or background dependencies change.

## Coupling
- `stores.svelte.ts` is imported almost everywhere, with the highest fan-out in the repo. Changing a store's semantics affects the UI, process, plugins, and sync code.
- `bootstrap.ts` depends on storage, `globalApi.svelte.ts`, plugins, drive/account/kei, cold storage, model registry, modules, and observers.
- Platform flags are consumed by storage, network, drive, cards, parser, translator, and settings.

## Invariants
- Do not flip `loadedStore` to true before `setDatabase`, `checkNewFormat`, theme setup, and `makeColdData` finish. `App` assumes `DBState.db` is normalized after that point. When `loadData` fails it only calls `alertError`, and the loading screen stays up.
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
- None cover boot, screen precedence, platform detection, hotkeys, observers, or `Mutex`.
- Some tests mock `stores.svelte` and `platform` (parser tests, `scriptings.test.ts`, `requests.responses.test.ts`). They exercise consumers, not these modules.

## Known Hazards
- `startObserveDom` creates a `MutationObserver` it never uses, and it polls forever with no cleanup.
- `isInStandaloneMode` has no consumers. `bootstrap.ts` recomputes standalone mode locally before calling `navigator.storage.persist`.
- `src/types.d.ts` and `src/vite-env.d.ts` both declare `Buffer`, `safeStructuredClone`, and `userScriptFetch`.
