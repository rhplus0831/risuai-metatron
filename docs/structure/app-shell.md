# App Shell

## Scope

- Owns: boot sequence, top-level screen selection, the URL routes and the history, global stores, platform flags, hotkeys, DOM observers, `Mutex`.
- Paths: `index.html`, `src/main.ts`, `src/boot.ts`, `src/startApp.ts`, `src/lib/Others/NodeServerRequired.svelte`, `src/App.svelte`, `src/ts/{bootstrap,safeBoot,stores.svelte,platform,polyfill,hotkey,defaulthotkeys,observer.svelte,mutex,keepAliveAudio}.ts`, `src/ts/router/`, `src/types.d.ts`, `src/vite-env.d.ts`, `src/lib/UI/MainMenu.svelte`, `src/lib/UI/Title.svelte`.
- Not here: DB shape and migrations → `persistence.md`. The save loop → [persistence](persistence.md); `globalFetch` → [global-api](global-api.md). Chat UI below `ChatScreen` → `ui-theming.md`. The server's client-route fallback (`shared/routes.ts`, `GET *` in `server/src/app.ts`) → `self-host-server.md`. The settings page numbers → `settings-i18n.md`.

## Files

- `src/main.ts`: entry. Imports `./ts/polyfill` and `core-js`, registers the `vite:preloadError` alert, then branches on `isNodeServer`: true → dynamic `import("./boot")` and `boot()`; false → mounts `NodeServerRequired` and removes `#preloading`. The app graph (App, bootstrap, stores, DB) is never imported without the server.
- `src/boot.ts` `boot`: starts the diagnostics collector (`src/ts/diagnostics/collector.ts`, `global-api.md`) before any app module loads, then dynamically imports `src/startApp.ts`; a failure while the app's modules load is an unhandled rejection the collector records.
- `src/startApp.ts` `startApp`: imports the database side effects, `mount(App)`, `loadData()` (not awaited), `initHotkey()`, and removes `#preloading`.
- `src/lib/Others/NodeServerRequired.svelte`: the notice shown when the client is opened without the self-host server (static hosting, a bare `vite build` output). English only (`language.nodeServerRequiredTitle`/`Desc`), since `changeLanguage` runs only after the DB loads.
- `src/App.svelte`: the screen selection (ordered `{#if}` chain), plus drag/drop import, overlays (alerts, popups, modals), and keep-alive audio.
- `src/ts/keepAliveAudio.ts` `createKeepAliveAudio`: the audio of "Keep Session Alive: Via Sound" (`settings.ui.keepSessionAlive === "sound"`). `App.svelte` holds one controller: a click in that mode calls `start()`, and any other mode calls `stop()`. Chrome counts a tab as playing audio by its measured output (silence below -72.25 dBFS), not the element's `volume`, and treats media of 5 s or less as transient (on Android: no media notification, no foreground service). So the level is in the waveform: a generated 10 s, 20 Hz, 16-bit mono WAV (8 kHz, amplitude 0.002, about -57 dBFS) as a Blob URL, looped at full volume. `start()` is a no-op while active; the element's `pause` event (the OS or another app took audio focus) or a rejected `play()` makes it inactive, so the next click plays the same element again. It sets `navigator.mediaSession.metadata` (title "Risuai"); `stop()` pauses and clears it.
- `src/ts/router/routes.ts`: the route table (pure). The slugs (`SETTINGS_PAGES`: slug → `SettingsMenuIndex`; `PLAYGROUND_TOOLS`: slug → `PlaygroundStore` value) are the only place that maps the magic numbers to URLs; the `Route` union; `formatRoute` (ids with `encodeURIComponent`) and `parseRoute` (null for anything that names no route: unknown or prototype slugs, empty segments, bad encoding); `settingsPageOf`/`playgroundToolOf`. Settings indices 7, 8, and 9 have no slug. `SETTINGS_PAGE_ALIASES` maps a former slug to its page (`bot` → `memory`): `parseRoute` reads it as that page, so the boot replace writes the current slug.
- `src/ts/router/router.svelte.ts`: `startRouter` and the history model (URL routes, below). `HistoryPort` wraps the browser (`browserHistory`: live `path`/`state`, `push`, `replace`, `entryBelow(n)` from the Navigation API, fire-and-forget `traverse(key)`, `popstate`), so the tests run a fake.
- `src/ts/bootstrap.ts`:
  - `loadData`: reads through `loadBootSnapshot` (`readBoot` with an IndexedDB cache and a plain `readKinds` fallback), then installs server records, runs maintenance and presentation setup, starts resource sync, imports browser-local data, loads plugins, sets `loadedStore = true`, then starts services. Cache rules and tests belong to [persistence](persistence.md), Load.
  - `installBootRecords`: installs the resource records into the settings and character records and the chat module (see `persistence.md`, Load); no whole-database object is built.
  - `applyFirstBootDefaults`: on a store's first boot (`settings.ui.didFirstSetup` unset) the UI language follows the browser's when the UI has it, then the flag is set. There is no first-run wizard: the app opens on the home screen, and every other setting keeps the server's default until the settings pages change it.
  - `maintainCharacters`: the boot's maintenance (trash pruning, then `checkCharOrderAtBoot` against the complete inventory to drop dangling order ids); no character default.
  - The boot's error alert (`loadData`'s catch) carries a line with the safe-boot address (`bootErrorWithSafeBootHint`, below).
  - `registerSw`: returns `ready`, `unavailable`, or `reloading`. Registration or initialization failure lets boot continue without the worker. A non-2xx `/sw/init` reloads once per tab, guarded by the `risu.serviceWorker.initReload` session marker; an existing marker or unavailable session storage skips the reload, and a successful init clears the marker. Failures retain the existing service-worker diagnostics; a reload also records the sync event and flushes diagnostics.
- `src/ts/safeBoot.ts`: safe boot, plugins or custom CSS and GUI HTML off for this page load (Flows, Safe boot). `createSafeBoot(deps)` is the controller with its effects injected (the query, `localStorage`, the clock, the timer, `SafeModeStore`, the notice); the module's own instance does nothing until `beginSafeBoot()`. Exports: `parseSafeFlag`, `beginSafeBoot`, `safeBootOff(category)` (read by `plugins.svelte.ts` and `PluginSettings.svelte`), `markSafeBootContentStage`, `latchSafeBootFailure`, `startSafeBootSettleWindow`, `bootErrorWithSafeBootHint`, `safeBootUrl`; `SAFE_BOOT_KEY`, `SAFE_BOOT_THRESHOLD` (2), `SAFE_BOOT_SETTLE_MS` (10 s).
- `src/ts/stores.svelte.ts`: all global UI stores (see State). `PlaygroundStore` is re-exported from `src/ts/storage/selection.svelte.ts`, so chat status can read the same writable without starting the UI stores' module effects.
- `src/ts/platform.ts`: `isNodeServer` (read only by `main.ts`), `isMobile`, `isIOS()`, `getRisuEnvironmentLabel` (`node` or `node(dev)`), `getDetailedOSLabel`, `isInStandaloneMode` (unused).
- `src/ts/polyfill.ts`: `safeStructuredClone` (native `structuredClone`, then an `rfdc` fallback), plus `Buffer` and stream polyfills and the mobile drag/drop polyfill.
- `src/vite-env.d.ts`: ambient declarations for the globals `Buffer`, `safeStructuredClone`, and `userScriptFetch`.
- `src/types.d.ts`: the `DeepPartial<T>` utility type only.
- `src/ts/hotkey.ts`:
  - `initHotkey`: keydown dispatch switch.
  - `hotkeyMatches`: reads the hotkey only (a missing modifier flag is "not held"); it never writes the stored list.
  - `enabledHotkeys` (the dispatch) and `activeHotkeys` (`HotkeySettings.svelte`): the stored hotkeys without `scrollToActiveChar` while `enableScrollToActiveChar` is off; `activeHotkeys` also hides `quickSettings`.
  - `quickSettings` (Ctrl+Q, still a default): the quick settings panel is removed, so it only shows `language.quickSettingsRemoved` (`alertNormal`) and keeps the key from the browser.
  - Ctrl+1..9 pick the prompt preset through `pickBinding` ([chat bindings](persistence.md)): the open chat's binding, else the tab's selection at home; nothing while a picker list or the binding dialog is open.
- `src/ts/defaulthotkeys.ts`: re-exports `defaultHotkeys` (declared in `shared/hotkeys.ts`) and the `Hotkey` type declared in `shared/settings.ts`.
- `src/ts/observer.svelte.ts`:
  - BGM sync is queued only for `risu-ctrl` attribute changes or added/removed element subtrees matching or containing `[risu-ctrl]`, keeping streamed text mutations out of the document-wide scan while preserving initial sync, macrotask coalescing, document order and grace timers.
  - `startObserveDom`: idempotent. Adds one `document` `contextmenu` delegate (Copy/Download menu for `x-hl-lang` code blocks) and a `MutationObserver` on `document.body` that syncs BGM from `risu-ctrl="bgm___<volume|auto>___<src>"` markers.
  - BGM: one track at a time. When nothing is playing, it starts the first marker in document order (the newest message, since the chat body is column-reversed). A playing track keeps playing while its marker stays in the DOM, even if a newer marker appears, and replays on `ended`. It stops `BGM_STOP_GRACE_MS` (1 s) after its marker is gone.
  - BGM failures: an autoplay block (`NotAllowedError`) pauses all BGM until the next activating `pointerup`/`keydown` (touch grants activation only on release). A source or media error skips only that marker, so another marker can still play; it is not retried on gestures, only after the marker has been missing from the DOM for more than 1 s and appears again.
- `src/ts/mutex.ts` `Mutex`: FIFO lock. Its users were the browser scripting engines, removed when scripting moved to the server, so nothing in production imports it now. `runExclusive` must keep its `finally` release.
- `src/lib/UI/MainMenu.svelte`: home screen. Pinned chats come first (shared `SideBars/pinnedChats.ts` collector over summaries; six cards until expanded, with an empty state); cards call `globalApi.openPinnedChat`, selecting the target chat before the character and opening it. Pinned cards show the same per-chat generating, recovery, or unseen badge as the sidebar rail, anchored over the icon with the status in the accessible name and hover title. Recent characters (`collectHomeRecentCharacters` in `src/lib/UI/mainMenuProjection.ts`: by `lastInteraction`, newest first, without the trash and `§playground`; a card calls `changeChar`, "View all" sets `gridOpenStore`), and an Explore card that switches to `RealmMain` via `OpenRealmStore` (hidden by `settings.ui.hideRealm`). It fetches nothing from Realm itself.
- `src/lib/UI/Title.svelte`: seasonal logo and mini-game. Only used by MainMenu.

## Flows

Boot:

1. `index.html` provides `#app` and a `#preloading` overlay, then loads `/src/main.ts`, which stops at the notice unless `__NODE__` was injected, and otherwise loads `boot.ts`.
2. `boot.ts:boot` starts the diagnostics collector, then `startApp.ts:startApp` mounts `App` before the DB is loaded. `App` shows the loading branch while `$loadedStore` is false.
3. `bootstrap.ts:loadData` first calls `beginSafeBoot()` (the `?safe` query, before anything navigates; Safe boot, below), then reads through `loadBootSnapshot`: `readBoot` claims the IndexedDB boot cache, with `readKinds` as fallback. See [persistence](persistence.md), Load, for cache behavior and fallback rules. `seedResources`/`seedChats`/`seedInlays` capture the returned snapshot before installation, then `loadSelection`, `installBootRecords`, and `registerSw` run. Only a `ready` worker enables `setUsingSw`; `unavailable` continues boot with object URLs for assets. On `reloading`, boot returns immediately with the loading screen up, preserving import hashes until navigation. A failed read only alerts; there is no local fallback.
4. Common tail of `loadData`:
   1. `maintainCharacters` (the trash pruning through `removeCharacters`, then `checkCharOrderAtBoot` against the complete inventory, before saving and the event feed start), and `initializeChats`.
   2. `markSafeBootContentStage()` (user content runs from here on: the attempt is counted, and a safe boot shows its notice), then presentation setup: `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, `updateHeightMode`, `updateErrorHandling`, `updateGuisize`.
   3. `startResourceSync()` (exactly once; starts the save adapter) and `watchRemoteRecords`: it drops the inlay caches whenever the adapter brought another tab's records in (`onRemoteRecordApplied` → `invalidateInlayCaches`), and after another writer's `characterOrder` it queues the add-only order repair (`queueRemoteCharOrderRepair`, `persistence.md` Save step 9). Then `characterURLImport` (not awaited): after the start, so a link's or share's module import waits for its save's acknowledgement (`addImportedModule`, [characters and modules](characters-modules.md)); before the router, which writes URLs without a query or hash.
   4. `importBrowserLocalData` (moves old browser-only data to the server), `loadPluginPermissions`, install remote-record owners, start the event feed, then `loadPluginsForBoot` (nothing while safe boot turned plugins off). Plugins load after normalization and ID assignment. A rejected plugin load is logged and fails the safe-boot attempt; the boot goes on.
   5. `loadedStore.set(true)`, `startSafeBootSettleWindow` (with the startup promises captured inside this boot's serialized plugin load), and `startRouter()`: the URL picks the screen, so a reload keeps it, the selected character included (URL routes, below).
   6. Push notifications, chat visibility/status tracking, resuming this tab's server jobs, DOM observers, `registerModelDynamic`, `moduleUpdate`, and `cleanLegacyAccountData`. There is no boot-time asset cleanup: orphaned `assets/*` files (including inlay blobs) are never purged automatically.

Safe boot (`safeBoot.ts`). A plugin with main-document access or a broken custom CSS or GUI HTML can make every boot unusable; safe boot turns them off for one page load, client only: nothing is written to the server and no persisted field changes.

- Categories: `plugins` and `css` (custom CSS and GUI HTML). `?safe` and `?safe=all` mean both; `?safe=plugins`, `?safe=css`, or a comma list (`?safe=plugins,css`) pick; unknown names are ignored. The query is read once, by `beginSafeBoot` at the start of `loadData`: the router's boot replace writes the path without it, so a reload after a settled boot can start normally.
- The counter: one `localStorage` record, `risu.safeBoot.attempts` = `{ count, at }`, read and written in `try` (an unavailable or throwing store leaves a normal boot without the counter; `?safe` still works; a malformed record reads as none). `markSafeBootContentStage` reads it and writes `count + 1` just before the theme, so a boot that fails earlier (an unreachable server, the service worker's reload) does not count.
- Failure latch: a rejected boot plugin load, the `loadData` catch, or a plugin this boot started whose script threw or did not run (`SandboxHost.startup` is `failed`, [plugins-mcp](plugins-mcp.md)) fails the attempt; nothing clears it in this page load. A guest unloaded before it reported (a toggle, a reload) follows its replacement after the `pluginReload` chain finishes, repeatedly until it reports or the settle window ends. No replacement counts as started only when that name is no longer an enabled API 3.0 plugin; otherwise it fails. Reloads of guests that already reported are not judged.
- Settled: `SAFE_BOOT_SETTLE_MS` (10 s) after `loadedStore` turned true, with no failure latched and every plugin this boot started reported as started (a guest still silent then fails the attempt). The settled boot removes the record, but only the one it wrote itself (compared by value), so a newer attempt of another tab stays counted.
- Trip: `markSafeBootContentStage` sees a previous `count >= SAFE_BOOT_THRESHOLD` (2) and successfully writes the increment: this boot turns both categories off before the theme runs. A failed write leaves only explicit `?safe` categories off, so a stale count cannot force later boots into safe mode while writes fail. Two boots that reached user content and did not settle (killed, failed, or reloaded within the window) make the third safe; a safe boot that settles clears the record, so the next reload is normal.
- Effects, this page load only: `plugins` off → `loadPlugins` loads nothing and registers no remote listener, so the deferred plugin reload never runs and the plugin settings save without loading ([plugins-mcp](plugins-mcp.md)); `css` off → `SafeModeStore` set before `updateTextThemeAndCSS` (custom CSS empty) and `Chat.svelte` renders the classic row instead of the `customHTML` theme's GUI HTML while it is set. The `toggleCSS` hotkey still flips `SafeModeStore` both ways.
- Notice: one `alertNormal` dialog (the alert queue) at the content stage when anything is off, naming what is off, why when the counter tripped it, and how to leave (keep the page open another 10 s after the app finishes loading, then reload without `?safe` to try a normal start; a failed start may leave automatic safe boot on). A boot that fails before its content stage shows it from the catch. The boot's error alert always gains a line with the safe-boot address (`/?safe` on this origin, plain text).
- Not covered: modules, global regex, and Lua run on the server per job; turning them off would need a flag in the job request.

Screen selection. `App.svelte` checks these in order:

1. April Fools branch.
2. Loading.
3. `$settingsOpen` → `Settings`.
4. `$gridOpenStore` → `GridChars`.
5. Otherwise `Sidebar` + `ChatScreen`.

Inside `DefaultChatScreen.svelte`:

- No selected character (`currentCharacter === undefined`) and `$PlaygroundStore === 0` → `MainMenu`.
- `$PlaygroundStore > 0` → lazy `PlaygroundMenu`.
- A character whose chat is not open (`selection.chatOpen` false; not the playground chat) → `ClosedChatScreen` (its name and an "Open most recent chat" button for its selected chat).
- Otherwise the chat.

URL routes (`src/ts/router/`). The stores above stay the state; the router keeps the URL and the history in sync with them in both directions. Overlays, modals, the side panel, and the sidebar's open state have no route.

- Base routes (a screen of its own): `/` home, `/realm`, `/chat/:chaId` (the closed chat), `/chat/:chaId/:chatId` (the open chat), `/playground`, `/playground/:tool`, `/playground/chat/:chatId` (the `§playground` character, `PlaygroundStore` 2).
- Layers over a base route: `/characters` (`gridOpenStore`), `/settings` (the list, index -1; on a screen 700 px or wider it is the model page) and `/settings/:page`. Settings wins over the grid, and open settings closes the grid (one layer at a time).
- Entry state: `{ v: 1, layerDepth, base?, rebased?, rootPending? }`. A layer entry records how many entries it is above its base route and that base, applied first on a reload.
- Applying a URL (boot and every `popstate`, the router's own back included) sets the stores (a chat calls `selectChat` before `selectCharacter`; `ensureChat` like `changeChar`), then replaces the entry with the canonical path. A URL that names no record is corrected by a replace: an unknown character or slug goes home, an unknown chat id falls back to the character's selected chat.
- The sync effect runs on a change of the shown route or of the base route under a layer (store changes that keep both take no step) and takes one step:
  - between base routes: a push (opening or closing a chat too); a replace for a chat switch within one character while its chat is open and for a removed character's entry; a back when the Navigation API lists the entry directly beneath with the target URL;
  - a layer opens with a push (a settings page on a narrow screen pushes the list under it); a close goes back to the base entry `layerDepth` beneath when the Navigation API lists it with the base the stores show, else replaces the layer entry with the base;
  - inside settings: the mobile list → a page and the prompt preset → its template push; a desktop page switch replaces; a back to the entry beneath only when it shows the target and the entry is not `rebased`; settings ↔ grid replaces;
  - a base change under an open layer (a grid pick, the Home hotkey in settings) is written into the layer entry and marks it `rebased`, so the close replaces instead of landing on the old base. A landing above depth 1 is marked `rebased` too.
- The router does not track its own back: it calls `traverseTo` and ignores the promises; the landing is applied like any `popstate`. Without the Navigation API it never goes back (a close replaces).
- A layer shown at boot without its base entry beneath (a link, a bookmark, an import that finished before the router started) is stamped `rootPending`; the base entry is inserted under it at the first user activation (trusted capture-phase `keydown` other than Escape, `mousedown`, mouse `pointerdown`, touch or pen `pointerup`, `touchend`, `click`), because Chrome's back button skips entries pushed without one.
- Store corrections that keep the route run in their own effect: the playground value 2 with nothing selected becomes 1, the settings list on a wide screen becomes the model page, open settings closes the grid.
- Escape closes the topmost layer only: an alert, else the prompt comparison (`PromptDiffModal`, a capture listener), else a picker list (persona, model preset, prompt preset), the Checkpoints dialog, or the chat binding dialog (`hotkey.ts` `topBindingLayer`; also from a focused text field), else the message search panel (`MessageSearch.svelte`, a capture listener that yields to those layers), else settings, else the grid. A checkpoint load blocks other hotkeys until its save, request, and refresh finish.
- Alert dialogs and keys: a newly shown dialog of `AlertComp`'s main branch (not the `wait`, `wait2`, or `progress` statuses) takes the focus, the panel itself (`tabindex="-1"`, so a stray Space clicks no button) or an `input` dialog's own field, and returns it to the element it took it from once no dialog is shown or queued (the saved element lives at module scope, since `AlertComp` unmounts in the gap between dialogs). So Enter and Escape reach `hotkey.ts` even when the dialog appeared over the composer. The dialog key gate (`createDialogKeyGate`) decides whether a stroke may answer: Enter answers `ask`/`normal`/`error` with "yes" and an `input` dialog with its field's value, a new Enter on a dialog button is left to that button's click, and Escape answers "". While a dialog is shown or queued, Escape stops at the document (window listeners of panels underneath never see it) and plain-key hotkeys (Space's `focusInput`) do not run; settings close with an Escape only when no dialog remains after it, so a rejected Escape leaves the dialog and settings open, while one that answers the last dialog closes both.

## State

All of these live in `src/ts/stores.svelte.ts`.

- `LoadingStatusState`.
- Navigation:
  - The selected character is not a store here: it is `selection.characterId` (`storage/selection.svelte.ts`: the selected `chaId` per tab, never stored, `null` at home), set with `selectCharacter(chaId)` and read as `selectedCharacter()`; `selectedIndex()` is its index in the list (a removed selected character selects home).
  - Whether its chat is open: `selection.chatOpen` (per tab, never stored), set with `setChatOpen`. Selecting another character (every entry point: the sidebar, the grid, the home cards, the hotkeys, imports) closes it, so a character starts on its closed-chat screen; `changeChatTo` (the closed-chat button, the chat lists, a new chat, a JSONL chat import) opens it, `openPinnedChat` opens a pinned chat across characters, and so does a bookmark jump; a JSON or HTML chat import only adds to the list. The chat module's `selectChat` only selects. Auto Mode stops at the end of its current send when the chat closes. The selected chat is still selected and loaded while closed, so readers of `selectedChat()` are unaffected; the playground chat ignores the flag.
  - `settingsOpen`, `SettingsMenuIndex` (not reset on close; the router maps it to `/settings/:page`).
  - `gridOpenStore`: the character grid (`GridChars`) in place of the sidebar and chat screen, opened by the sidebar and the home screen, `/characters`.
  - `sideBarStore`, `DynamicGUI`.
  - `PlaygroundStore`, `OpenRealmStore`.
  - `CharConfigSubMenu`, `botMakerMode`.
- Reload signals:
  - `ReloadGUIPointer`: its subscriber clears `ReloadChatPointer` and calls `resetTransformEffects` (the script transform's applied emotions, `cbs-rendering.md`).
  - `ReloadChatPointer`.
- The message search panel's open state and scope (`messageSearchPanel`, `openMessageSearch`) and the pending jump to a message live in `src/ts/messageSearch.svelte.ts`, not here ([ui-theming](ui-theming.md) `MessageSearch.svelte`): a jump is dropped when another character is selected (`onCharacterSelectionChanged`), when the selected chat is another one at any flush (so coming back never runs it again) or when its chat closes. Selecting the same chat again keeps it: closing the catalog over that chat makes the router re-apply its URL with `selectChat`, which bumps `chatSelectionVersion` without a move. A move away and back inside one flush is not seen.
- The Checkpoints dialog and its busy state live in `src/ts/checkpoints/chatCheckpoints.svelte.ts`, not here; see [ui-theming](ui-theming.md). Its load blocks global hotkeys until the save, request, and refresh finish.
- Overlays: `alertStore`, `terminalNotice` (`TerminalNotice.svelte`, a modal dialog above every other overlay), `popupStore`, `popUpEditorStore`, `irisStore`, `bookmarkListOpen`, `hypaV3ModalOpen`, `hypaV3ProgressStore`, the picker lists `openPresetList`/`openModelPresetList`/`openPersonaList` (`PickerListState`: `true` for what the screen shows, or `{ chatRef }` for one chat), and `chatBindingDialog` (the chat whose binding dialog is open, or null).
- Plugin extension arrays (runes): `additionalSettingsMenu`, `additionalFloatingActionButtons`, `additionalHamburgerMenu`, `additionalChatMenu`, `chatPanelStore`, `bodyIntercepterStore`. Types are `MenuDef` and `ChatPanelDef`.
- Misc: `CustomCSSStore` (its subscriber injects CSS with `innerHTML`), `SafeModeStore` (custom CSS and GUI HTML off: the `toggleCSS` hotkey, or a safe boot's `css` category), `CharEmotion`, `ScrollToMessageStore`, `hotReloading`, `disableHighlight`.
- Root `$effect`: reruns `moduleUpdate` when module, chat, or background dependencies change.

## Coupling

- `stores.svelte.ts` is imported almost everywhere, with the highest fan-out in the repo. Changing a store's semantics affects the UI, process, plugins, and sync code.
- `bootstrap.ts` depends on storage, `globalApi.svelte.ts`, plugins, model registry, modules, and observers.
- `isNodeServer` is consumed only by `main.ts`. `isMobile`/`isIOS` are consumed by UI code.

## Invariants

- Safe boot is per page load: it writes nothing to the server and no persisted field, only the `risu.safeBoot.attempts` record. What it turns off stays off until the page reloads, in this tab only. Read `?safe` before anything navigates.
- Do not flip `loadedStore` to true before `installBootRecords`, `maintainCharacters`, and theme setup finish. `App` assumes the records are installed after that point. When `loadData` fails it only calls `alertError`, and the loading screen stays up.
- No selected character is home. Components read the selected character as `const currentCharacter = $derived(selectedCharacter())` and the list as `characterList()`, never by an index; a handler that awaits captures the `chaId` first and finds the character again after the await.
- Call `startResourceSync()` only once, from `loadData`; it ignores a second call.
- `isNodeServer` depends on `server/src/app.ts` (`GET /` and `/index.html`) or the Vite dev plugin `risu-node-flag` injecting `globalThis.__NODE__ = true` into `index.html`. Keep everything the app needs behind the dynamic `boot.ts` import so the notice path initializes nothing.
- The stores are the screen state. Change the screen by setting them; do not call `history.pushState`/`replaceState` for a screen (another script's write fires no `popstate`, and the router overwrites it at the next store change). The router writes paths without a query or hash: a link parameter is consumed at boot (`characterURLImport` removes `?realm=`, `?charahub=`, and `#import=` with `replaceState` and reads the hash before its first `await`).
- `startRouter()` runs once, after `loadedStore` is set and the plugins have loaded; a second call does nothing.
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
  4. A screen of its own gets a route (a modal or overlay does not): a `Route` kind with `formatRoute`/`parseRoute` in `router/routes.ts`; a new first path segment in `CLIENT_ROUTE_SEGMENTS` (`shared/routes.ts`) so the server serves the client there; in `router.svelte.ts` the store mapping in `baseRouteOfState` or `layerRouteOfState` and its application in `applyBase` or `applyLayer`; tests in `routes.test.ts` and `router.test.ts`. A new settings page or playground tool needs only its slug in the table.
  5. Verify with `pnpm check`, a fresh load, and a reload on the new screen.
- Change startup:
  - Server gate: `main.ts`.
  - Ordering: `boot.ts`.
  - Data and platform sequencing: `bootstrap.ts:loadData`.
  - Keep the `loadedStore` transition intact.
- Add a platform-specific behavior:
  1. Add or adjust the flag in `platform.ts`.
  2. Update every consumer.
  3. There is no browser-only runtime to keep working; do not reintroduce `isNodeServer` branches past `main.ts`.
- Add a hotkey: `shared/hotkeys.ts` (`defaultHotkeys`), `hotkey.ts:initHotkey`; the server `hotkeys` normalizer (`server/src/data/normalize/collections.ts`) merges a new built-in hotkey into stored lists by `action`. A hotkey gated by a setting is filtered by the readers (`enabledHotkeys`, `activeHotkeys`), not removed from the list.

## Tests

- `src/boot.test.ts`: the entry's order over stubbed modules: importing `boot.ts` evaluates the collector only, and `boot()` starts it before `startApp.ts` is loaded and started.
- `src/ts/bootstrap.serviceWorker.test.ts`: `loadData` over a store-backed server with a fake `navigator.serviceWorker`, `fetch`, `location.reload`, and `sessionStorage`: a rejected registration or `/sw/init` fetch records its diagnostic and the boot completes (`loadedStore` true, `characterURLImport` and `startRouter` run once) with `getFileSrc` answering an object URL and never fetching `/sw/check`; a non-2xx `/sw/init` reloads once with the marker set and the diagnostics flushed, and nothing after the worker step runs; the marker present, or a throwing `sessionStorage`, boots without the worker and without a reload; a 2xx clears the marker and `getFileSrc` answers `/sw/img/<hex>`; a missing `navigator.serviceWorker` keeps the `unsupported` path.
- The bootstrap suites share the complete typed service defaults in `src/ts/tests/bootMocks.ts`; each keeps its hoisted mock registrations and scenario overrides. Handwritten `stores.svelte.ts` doubles use `src/ts/tests/storesMock.ts`, which omits DOM subscriptions and module effects.
- Safe boot: `src/ts/safeBoot.test.ts` covers the controller's query parsing, attempt counter, failure latch, and settle window; `src/ts/bootstrap.safeBoot.test.ts` covers those behaviors through `loadData`, including the content-stage order and plugin-start outcomes.
- Boot cache is tested in `src/ts/storage/tests/bootCache.test.ts` and `src/ts/storage/tests/bootCacheServer.test.ts`; see [persistence](persistence.md), Load, for ownership and cache behavior.
- `src/ts/hotkey.test.ts`: Ctrl+1–9 preset routing, suppression by picker/dialog layers, Escape layer order, Ctrl+Q (`quickSettings`: the removal notice, the default prevented; `activeHotkeys` hides it from the table), `previewRequest` (the `previewChat` body shown; a refused preview shows nothing and clears only its own wait; a busy chat refused before any wait), and the dialog keys (a rejected Escape keeps the dialog and settings, Escape stops at the document while a dialog is shown or queued, no plain-key hotkey behind a dialog, a new Enter on a dialog button left to its click). `src/lib/Others/AlertComp.test.ts`: a dialog takes the focus from the composer (its panel, or an `input` dialog's field), Enter and Escape then answer it, and the focus returns once no dialog remains (across the gap between two, never over focus moved elsewhere); the statuses take no focus. Screen precedence, platform detection, the other hotkey actions, and `Mutex` lack focused unit coverage.
- `src/ts/router/routes.test.ts`: the route table (every slug both ways, encoding, unknown input). `src/ts/router/router.test.ts`: the router against a fake `HistoryPort` with the real store graph and Svelte effects: boot with and without state, every `popstate` applied, the history steps, backs only to a listed entry and never without the Navigation API, no retry of a back that did nothing, the closed chat (an open pushes, a switch while open replaces, Go Back goes back, a selection closes, the playground ignores it), the layers (depths, close by back or replace, layer switches, base changes and `rebased`, the mobile list), the root insertion and its events, and `browserHistory` against happy-dom and a fake Navigation API. `server/src/tests/app.test.ts` covers the client-route fallback.
- Not covered by unit tests: Chrome's skipping of entries pushed without a user activation, and real Navigation API behavior (checked by hand).
- `src/ts/observer.test.ts` covers `startObserveDom` under happy-dom with an `Audio` stub and fake timers: BGM marker parsing, selection, grace stop, failure and autoplay retry policy, and the delegated code-block menu. Mutation records are delivered with `takeRecords()` because happy-dom's own timer is not faked. `src/ts/observer.markers.test.ts`: the BGM sync's document-wide `[risu-ctrl]` scan does not run for text or plain HTML mutations and runs once for an added or removed marker element (nested or not) and for a `risu-ctrl` attribute change, with the playback that follows.
- `src/ts/keepAliveAudio.test.ts`: the keep-alive controller over stubbed `Audio`, `URL.createObjectURL`, and `navigator.mediaSession`: one looping element at full volume with the metadata, a repeated start plays nothing new, the generated WAV (format, 10 s, about -57 dBFS RMS, 20 Hz), the same element again after an outside `pause` or a rejected `play()` (no unhandled rejection), and `stop()` (paused, metadata cleared, nothing before a start). Whether Chrome shows the tab as playing audio is checked by hand.
- `src/lib/UI/mainMenuProjection.test.ts`: the home screen's recent characters (order, tie by name, limit, the trash, `§playground`, and no stamp left out) and the relative-time text.
- Some tests mock `stores.svelte` and `platform` (the parser tests). They exercise consumers, not these modules.

## Known Hazards

- Safe boot's counter is a heuristic shared by the tabs of a browser: a user who reloads twice within 10 s of loading trips it once, two tabs booting at once can overwrite each other's count (the read and the write are not atomic), and a boot that settles only clears its own record. A plugin whose script throws at start fails every boot it runs in, so a normal start with it enabled is safe again every third boot until it is fixed or disabled.

- `src/etc/patchNote.ts` has no importers; it does not drive the current release UI.

- The router's accepted limits (it waits for nothing, never loops, never traverses to an entry the Navigation API does not list, and the URL catches up by the next store change):
  - a click made between a back and its landing is undone by the landing;
  - a back can do nothing (an entry dropped at the browser's session history cap, 50 entries in Chromium and Firefox, 100 in WebKit); the URL then stays one step behind until the next store change;
  - overlapping navigations (the user's back, another script's history write, a router step) have no defined winner;
  - without the Navigation API (iOS before 26.2, older Firefox) the router never goes back, so the history grows and a back after a close shows the same screen again;
  - after a back and a forward inside settings, a close replaces instead of going back (the entries beneath may name another base).
- A back pressed before any interaction on a directly opened settings or grid link leaves the app, like any first page.

- BGM stop detection is marker-based. If a message re-render keeps its BGM marker out of the DOM for more than 1 s (for example a slow re-parse), the track stops and restarts from the beginning.
- `isInStandaloneMode` has no consumers. `bootstrap.ts` recomputes standalone mode locally before calling `navigator.storage.persist`.
- A user-defined `send` hotkey clicks `.button-icon-send` without the popup-editor guard of the preset hotkeys, so it can send (and run `presetChain`) while a popup editor is open.
- The `ReloadGUIPointer` subscriber in `stores.svelte.ts` skips its first call: `subscribe` calls back at once while the module is still evaluating, and `stores.svelte.ts` and `parser/transformClient.ts` import each other, so that call could reach `resetTransformEffects` before `transformClient`'s bindings exist. Keep the skip while the cycle remains (`stores.importOrder.test.ts`).
