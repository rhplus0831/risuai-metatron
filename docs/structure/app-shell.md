# App Shell

## Scope

- Owns: boot sequence, top-level screen selection, the URL routes and the history, global stores, platform flags,
  hotkeys, DOM observers, `Mutex`.
- Paths: `index.html`, `src/main.ts`, `src/boot.ts`, `src/startApp.ts`, `src/lib/Others/NodeServerRequired.svelte`,
  `src/App.svelte`,
  `src/ts/{bootstrap,safeBoot,stores.svelte,screenVisibility,popupEditorSession.svelte,pageVisibility.svelte,platform,polyfill,hotkey,ime,defaulthotkeys,observer.svelte,mutex,keepAliveAudio}.ts`,
  `src/ts/router/`, `shared/hotkeys.ts`, `src/types.d.ts`, `src/vite-env.d.ts`, `src/lib/UI/MainMenu.svelte`,
  `src/lib/UI/Title.svelte`, `src/etc/patchNote.ts`. `bootstrap.ts` `loadData` is shared with resource sync
  (`pnpm docs:owner`).
- Not here: DB shape and migrations → `persistence.md`. The save loop → [save cycle](resource-sync.md#save-cycle);
  `globalFetch` → [network-jobs](network-jobs.md). Chat UI below `ChatScreen` → `ui-theming.md`. The server's
  client-route fallback (`shared/routes.ts`, `GET *` in `server/src/app.ts`) → `self-host-server.md`. The settings page
  numbers → `settings-i18n.md`. Alert and terminal-notice surfaces → `global-api.md`.

## Files

### Entry and screens

- `src/main.ts`: the entry and the server gate (`isNodeServer`): the dynamic `./boot` import, or only
  `NodeServerRequired`. Its header says why the app graph stays behind that import.
- `src/boot.ts` `boot`: the diagnostics collector (`src/ts/diagnostics/collector.ts`, [diagnostics](diagnostics.md))
  before any app module loads, then `src/startApp.ts` `startApp` (mounts `App`, starts `loadData`, `initHotkey`).
- `src/lib/Others/NodeServerRequired.svelte`: the notice without the self-host server, English only.
- `src/App.svelte`: the screen selection ([Screen selection](#screen-selection)), the overlays, the drag/drop import,
  and the one keep-alive controller.
- `src/ts/keepAliveAudio.ts` `createKeepAliveAudio`: "Keep Session Alive: Via Sound"
  (`settings.ui.keepSessionAlive === "sound"`); its header documents the audio requirements.

### Router

- `src/ts/router/routes.ts`: the route table (pure): `Route`, `formatRoute`, `parseRoute`, `SETTINGS_PAGES`,
  `PLAYGROUND_TOOLS`, `SETTINGS_PAGE_ALIASES`, `settingsPageOf`, `playgroundToolOf`. The only place that maps the
  `SettingsMenuIndex` and `PlaygroundStore` numbers to URLs.
- `src/ts/router/router.svelte.ts`: `startRouter`, `openRoute`, and the history model ([URL routes](#url-routes)):
  `HistoryPort` (`browserHistory` over the Navigation API; a fake in the tests), `RouteState`, `sync`,
  `baseRouteOfState`/`layerRouteOfState`, `applyBase`/`applyLayer`.

### Bootstrap

- `src/ts/bootstrap.ts`: `loadData` ([Boot](#boot); the snapshot read and its cache are
  [resource sync](resource-sync.md#boot-cache)), `installBootRecords` (resource records into their owners, not a
  whole-database object: [boot load](resource-sync.md#boot-load)), `applyFirstBootDefaults` (the UI language only; no
  setup wizard or character default), `registerSw` (its three outcomes), `maintainCharacters`, `watchRemoteRecords`.
- `src/ts/safeBoot.ts`: the safe-boot controller ([Safe boot](#safe-boot)): `createSafeBoot` (effects injected, so the
  tests run it), `parseSafeFlag`, `beginSafeBoot`, `safeBootOff`, `markSafeBootContentStage`, `latchSafeBootFailure`,
  `startSafeBootSettleWindow`, `bootErrorWithSafeBootHint`, `safeBootUrl`; `SAFE_BOOT_KEY`, `SAFE_BOOT_THRESHOLD`,
  `SAFE_BOOT_SETTLE_MS`.

### Stores and platform

- `src/ts/stores.svelte.ts`: the global UI stores ([State](#state)) and the effects the module starts when it loads.
- `src/ts/screenVisibility.ts` (`settingsOpen`, `gridOpenStore`, `bookmarkListOpen`, `hypaV3ModalOpen`) and
  `src/ts/popupEditorSession.svelte.ts` (`popUpEditorStore`, `openPopupEditorSession`): stores other modules read
  without starting those effects; `stores.svelte.ts` re-exports them, and `PlaygroundStore` from
  `src/ts/storage/selection.svelte.ts`.
- `src/ts/pageVisibility.svelte.ts` `isPageVisible`, `pageRecoveryVersion`; `src/ts/ime.ts` `isImeComposing`.
- `src/ts/platform.ts`: `isNodeServer` (read only by `main.ts`), `aiDisclosureEnabled` (the injected
  `__RISU_AI_DISCLOSURE__` flag, read only by `aiLawApplies` in `globalApi`), `isMobile`, `isIOS`,
  `getRisuEnvironmentLabel`, `getDetailedOSLabel`, `getFallbackOSLabel`, `isInStandaloneMode` (unused).
- `src/ts/polyfill.ts` `safeStructuredClone` and the global polyfills; `src/vite-env.d.ts` declares the globals
  (`Buffer`, `safeStructuredClone`, `userScriptFetch`); `src/types.d.ts` holds `DeepPartial<T>` only.
- `src/ts/mutex.ts` `Mutex`: a FIFO lock that nothing in production imports.

### Hotkeys and observers

- `src/ts/hotkey.ts`: `initHotkey` (the key handler and its dispatch switch), `hotkeyMatches`, `enabledHotkeys` and
  `activeHotkeys` (`HotkeySettings.svelte`'s list), `changeToPreset` (Ctrl+1..9 through `pickBinding`,
  [chat bindings](persistence.md)), and the `quickSettings` key, which only shows `language.quickSettingsRemoved`. Alert
  key gating is in [global-api](global-api.md#alert-queue); picker/dialog priority is in
  [UI](ui-theming.md#dialogs-popovers-and-portals).
- `shared/hotkeys.ts` `defaultHotkeys`, re-exported by `src/ts/defaulthotkeys.ts` with the `Hotkey` type of
  `shared/settings.ts`.
- `src/ts/observer.svelte.ts` `startObserveDom`: the BGM markers (`risu-ctrl`, `BGM_STOP_GRACE_MS`) and the `x-hl-lang`
  code-block context menu.

### Home screen

- `src/lib/UI/MainMenu.svelte`: the home screen (pinned chats, recent characters, Explore); it fetches nothing from
  Realm itself. The recent list is `src/lib/UI/mainMenuProjection.ts` `collectHomeRecentCharacters`.
- `src/lib/UI/Title.svelte`: the seasonal logo and mini-game, used only by `MainMenu.svelte`.

## Flows

### Boot

1. `index.html` loads `main.ts`; without the injected `__NODE__` flag it mounts only the server-required notice (the
   same script injects `__RISU_AI_DISCLOSURE__`, the operator's AI disclosure choice that `aiLawApplies` reads).
   Otherwise `boot()` starts diagnostics and `startApp()` mounts `App` before data loads, leaving the loading branch up.
2. `loadData()` reads `?safe` before navigation, reads the server snapshot, resolves the tab selection, installs
   records, applies first-boot defaults, then awaits [draft recovery](draft-recovery.md#boot-recovery) before
   registering the service worker. A failed snapshot read alerts and stops boot; there is no local snapshot fallback.
   Snapshot cache rules are in [resource sync](resource-sync.md#boot-cache).
3. Boot maintenance and chat initialization run before the safe-boot content stage and presentation setup. Then the save
   adapter and remote-record watchers start, followed by URL/share imports, legacy-data migration, the event feed, and
   plugin loading. The ordering matters: imports can await save acknowledgements and consume link query/hash data before
   the router canonicalizes the URL.
4. `loadedStore` is set only after records, maintenance, and theme setup. The safe-boot settle window and router start
   next; notifications, job resume, observers, and remaining startup hooks follow. `startResourceSync()` and
   `startRouter()` each run once.

### Safe boot

A plugin with main-document access or a broken custom CSS or GUI HTML can make every boot unusable; safe boot turns them
off for one page load, client only: nothing is written to the server and no persisted field changes. The controller's
rules (the `?safe` forms, the `risu.safeBoot.attempts` counter, the trip, settling, the notice) are in the
`src/ts/safeBoot.ts` header; this is where its stages sit in the boot.

- `loadData` calls `beginSafeBoot` first (`?safe` is read before the router's boot replace drops it),
  `markSafeBootContentStage` just before the theme (a boot that fails earlier does not count), and
  `startSafeBootSettleWindow` once `loadedStore` is true. Its catch alerts `bootErrorWithSafeBootHint`, which adds the
  safe-boot address (`/?safe`) to every boot error.
- A failure is latched by a rejected `loadPluginsForBoot`, the `loadData` catch, or a plugin this boot started whose
  script threw or did not run (`SandboxHost.startup` is `failed`, [plugins](plugin-sandbox.md)). A guest unloaded before
  it reported follows its replacement after the `pluginReload` chain (`captureBootGuests` in
  `src/ts/plugins/plugins.svelte.ts`); a guest still silent when the settle window ends fails the attempt.
- `plugins` off: `loadPlugins` loads nothing and registers no remote listener, so the deferred plugin reload never runs
  and the plugin settings save without loading ([plugins](plugin-sandbox.md)). `css` off: `SafeModeStore` is set before
  `updateTextThemeAndCSS` (custom CSS empty), and `Chat.svelte` renders the classic row instead of the `customHTML`
  theme's GUI HTML while it is set. The `toggleCSS` hotkey still flips `SafeModeStore` both ways.
- Not covered: modules, global regex, and Lua run on the server per job; turning them off would need a flag in the job
  request.

### Screen selection

This is `App.svelte`'s render order, checked top down. A new screen or overlay follows
[Add a screen or modal](#add-a-screen-or-modal).

1. April Fools branch.
2. Loading.
3. `$settingsOpen` → `Settings`.
4. `$gridOpenStore` → `GridChars`.
5. Otherwise `Sidebar` + `ChatScreen`.

Inside `DefaultChatScreen.svelte`:

- No selected character (`currentCharacter === undefined`) and `$PlaygroundStore === 0` → `MainMenu`.
- `$PlaygroundStore > 0` → lazy `PlaygroundMenu`.
- A character whose chat is not open (`selection.chatOpen` false; not the playground chat) → `ClosedChatScreen` (its
  name and an "Open most recent chat" button for its selected chat).
- Otherwise the chat.

### URL routes

The files are in [Router](#router); a new route follows [Add a screen or modal](#add-a-screen-or-modal). The stores stay
the state; the router keeps the URL and the history in sync with them in both directions (the `router.svelte.ts` header
and the comments on `sync`, `applyEntry`, and `normalize` give the step rules). Overlays, modals, the side panel, and
the sidebar's open state have no route.

- Base routes (a screen of its own): `/` home, `/realm`, `/chat/:chaId` (the closed chat), `/chat/:chaId/:chatId` (the
  open chat), `/playground`, `/playground/:tool`, `/playground/chat/:chatId` (the `§playground` character,
  `PlaygroundStore` 2).
- Layers over a base route: `/characters` (`gridOpenStore`), `/settings` (the list, index -1; on a screen 700 px or
  wider it is the model page) and `/settings/:page`. Settings wins over the grid, and open settings closes the grid (one
  layer at a time). A layer entry's `RouteState` records its depth above its base route and that base, applied first on
  a reload.
- Applying a URL (boot and every `popstate`, the router's own back included) sets the stores through the chat store and
  the selection (`selectChat` before `selectCharacter`; `ensureChat` like `changeChar`), then replaces the entry with
  the canonical path; a URL that names no record goes home or to the character's selected chat.
- A store change of the shown route, or of the base under a layer, is written to the history: nothing, a replace, a push
  (a settings page on a narrow screen pushes the list under it), or a back (`traverseTo`, never awaited) to an entry the
  Navigation API lists beneath with the target. Without the Navigation API the router never goes back. A base change
  under an open layer marks the layer entry `rebased`.
- A layer shown at boot without its base entry beneath (a link, a bookmark, an import that finished before the router
  started) is stamped `rootPending`; the base entry is inserted under it at the first user activation
  (`startRootInsertion`), because Chrome's back button skips entries pushed without one.

### Escape order

Escape closes the topmost layer only, in this order:

1. An alert ([Alert dialog keys](#alert-dialog-keys) has where Escape stops while a dialog is shown or queued).
2. The prompt comparison (`PromptDiffModal`, a capture listener).
3. A picker list (persona, model preset, prompt preset), the Checkpoints dialog, or the chat binding dialog
   (`src/ts/gui/dialogLayers.ts` `topBindingLayer`, handled in `hotkey.ts`; also from a focused text field).
4. The message search panel (`MessageSearch.svelte`) or the bookmark list (`BookmarkList.svelte`), each a capture
   listener that yields to those layers.
5. Settings.
6. The grid.

A checkpoint load blocks other hotkeys until its save, request, and refresh finish.

### Alert dialog keys

Escape's place among the other layers is in [Escape order](#escape-order).

- A newly shown dialog of `AlertComp`'s main branch (not the `wait`, `wait2`, or `progress` statuses) takes the focus:
  the panel itself (`tabindex="-1"`, so a stray Space clicks no button) or an `input` dialog's own field.
- It returns the focus to the element it took it from once no dialog is shown or queued (the saved element lives at
  module scope, since `AlertComp` unmounts in the gap between dialogs). So Enter and Escape reach `hotkey.ts` even when
  the dialog appeared over the composer.
- The dialog key gate (`createDialogKeyGate`) decides whether a stroke may answer: Enter answers `ask`/`normal`/`error`
  with "yes" and an `input` dialog with its field's value, a new Enter on a dialog button is left to that button's
  click, and Escape answers "".
- While a dialog is shown or queued, Escape stops at the document (window listeners of panels underneath never see it)
  and plain-key hotkeys (Space's `focusInput`) do not run.
- Settings close with an Escape only when no dialog remains after it, so a rejected Escape leaves the dialog and
  settings open, while one that answers the last dialog closes both.

## State

`src/ts/stores.svelte.ts` exports most global UI stores; some are defined in `screenVisibility.ts`, and navigation
selection lives in `src/ts/storage/selection.svelte.ts`.

- Navigation lives in `src/ts/storage/selection.svelte.ts`, not in these stores: `selection.characterId` is per-tab and
  `null` means home; `selection.chatOpen` controls whether the selected character's chat is open. Read character
  identity with `selectedCharacter()`/`selectCharacter()`, never a retained list index ([invariant](#invariants)).
- `settingsOpen` and `gridOpenStore` are defined in `screenVisibility.ts`; `SettingsMenuIndex` persists across closing
  settings and maps to `/settings/:page`. `PlaygroundStore` is re-exported from selection so chat status can avoid
  importing this module's effects.
- Other screen state includes `sideBarStore`, `DynamicGUI`, `OpenRealmStore`, and `CharConfigSubMenu`. Reload signals
  are `ReloadGUIPointer` (also resets script transform effects) and `ReloadChatPointer`. `LoadingStatusState` drives the
  loading branch; `botMakerMode` controls bot-maker UI.
- Overlay stores include alerts/notices, popups, picker lists, bookmarks, HypaV3, and chat binding. Their mount and key
  order belongs to [UI](ui-theming.md); checkpoint state belongs to [chat store](chat-store.md#chat-checkpoints).
- Plugin extension stores are `additionalSettingsMenu`, `additionalFloatingActionButtons`, `additionalHamburgerMenu`,
  `additionalChatMenu`, `chatPanelStore`, and `bodyIntercepterStore`.
- `CustomCSSStore` injects CSS; `SafeModeStore` disables custom CSS and custom GUI HTML. The root effect reruns
  `moduleUpdate` when module, chat, or background dependencies change.

## Coupling

- `stores.svelte.ts` is imported almost everywhere, with the highest fan-out in the repo. Changing a store's semantics
  affects the UI, process, plugins, and sync code.
- `bootstrap.ts` depends on storage, `globalApi.svelte.ts`, plugins, model registry, modules, and observers.
- `isNodeServer` is consumed only by `main.ts`. `isMobile`/`isIOS` are consumed by UI code.

## Invariants

- Safe boot is per page load: it writes nothing to the server and no persisted field, only the `risu.safeBoot.attempts`
  record. What it turns off stays off until the page reloads, in this tab only (the `toggleCSS` hotkey can still flip
  `SafeModeStore`). Read `?safe` before anything navigates.
- Do not flip `loadedStore` to true before `installBootRecords`, `maintainCharacters`, and theme setup finish. `App`
  assumes the records are installed after that point. When `loadData` fails before that point it only calls
  `alertError`, and the loading screen stays up; a rejected plugin load is latched and still sets `loadedStore`.
- No selected character is home. Components read the selected character as
  `const currentCharacter = $derived(selectedCharacter())` and the list as `characterList()`, never by an index; a
  handler that awaits captures the `chaId` first and finds the character again after the await.
- Call `startResourceSync()` only once, from `loadData`; it ignores a second call.
- `isNodeServer` and `aiDisclosureEnabled` depend on the server's `index.html` (`serveCachedIndex` in
  `server/src/http/staticCache.ts`, for `/`, `/index.html`, and the client routes) or the Vite dev plugin
  `risu-node-flag` injecting one script, `globalThis.__NODE__ = true; globalThis.__RISU_AI_DISCLOSURE__ = <bool>` (the
  server's `RISU_AI_DISCLOSURE`, or the dev shell's). Both are page-lifetime constants. Keep everything the app needs
  behind the dynamic `boot.ts` import so the notice path initializes nothing.
- The stores are the screen state. Change the screen by setting them; do not call `history.pushState`/`replaceState` for
  a screen (another script's write fires no `popstate`, and the router overwrites it at the next store change). The
  router writes paths without a query or hash: a link parameter is consumed at boot (`characterURLImport` and its
  `getRealmInfo` remove `?realm=`, `?charahub=`, and `#import=` with `replaceState`; it reads them before its first
  `await`).
- `startRouter()` runs once, after `loadedStore` is set and the plugin load has finished or failed; a second call does
  nothing.
- New hotkey actions need:
  - an entry in `defaultHotkeys`,
  - a branch in the `initHotkey` dispatch switch,
  - a check that the server's `hotkeys` normalizer merges new default actions into saved hotkeys.
- `safeStructuredClone` is a global installed by `polyfill.ts`, which must stay the first import in `main.ts` (before
  the `boot.ts` import).

## Recipes

### Add a screen or modal

1. Add a store in `stores.svelte.ts`.
2. Add its branch or overlay in `App.svelte`, respecting the branch order.
3. Set the store from the caller.
4. A screen of its own gets a route (a modal or overlay does not): a `Route` kind with `formatRoute`/`parseRoute` in
   `router/routes.ts`; a new first path segment in `CLIENT_ROUTE_SEGMENTS` (`shared/routes.ts`) so the server serves the
   client there; in `router.svelte.ts` the store mapping in `baseRouteOfState` or `layerRouteOfState` and its
   application in `applyBase` or `applyLayer`; tests in `routes.test.ts` and `router.test.ts`. A new settings page or
   playground tool needs only its slug in the table.
5. Verify with `pnpm check`, a fresh load, and a reload on the new screen.

### Change startup

- Server gate: `main.ts`.
- Ordering: `boot.ts`.
- Data and platform sequencing: `bootstrap.ts:loadData`.
- Keep the `loadedStore` transition intact.

### Add platform behavior

1. Add or adjust the flag in `platform.ts`.
2. Update every consumer.
3. There is no browser-only runtime to keep working; do not reintroduce `isNodeServer` branches past `main.ts`.

### Add a hotkey

`shared/hotkeys.ts` (`defaultHotkeys`), `hotkey.ts:initHotkey`; the server `hotkeys` normalizer
(`server/src/data/normalize/collections.ts`) merges a new built-in hotkey into stored lists by `action`. A hotkey gated
by a setting is filtered by the readers (`enabledHotkeys`, `activeHotkeys`), not removed from the list.

## Tests

Runner, slow-test, and timing rules belong to [test-harness](test-harness.md). This area has no `slow` tests.

- Boot and safe boot: `pnpm --silent test:agent src/boot.test.ts src/ts/bootstrap.*.test.ts src/ts/safeBoot.test.ts`.
- Router: `pnpm --silent test:agent src/ts/router`.
- Hotkeys and dialogs: `pnpm --silent test:agent src/ts/hotkey*.test.ts src/lib/Others/AlertComp.test.ts`.
- Observers and home:
  `pnpm --silent test:agent src/ts/observer*.test.ts src/ts/keepAliveAudio.test.ts src/lib/UI/mainMenuProjection.test.ts`.
- `e2e`: `e2e/openChat.spec.ts` drives the chat routes in a browser; `e2e/0-idleReload.spec.ts` the first boot's
  defaults.
- `src/ts/tests/bootMocks.ts`: the complete typed service defaults the bootstrap suites share; each suite keeps its
  hoisted mock registrations and scenario overrides.
- `src/ts/tests/storesMock.ts`: the base of handwritten `stores.svelte.ts` doubles; it omits DOM subscriptions and
  module effects.
- Some tests mock `stores.svelte` and `platform` (the parser tests). They exercise consumers, not these modules.
- `src/boot.test.ts` runs the entry's order over stubbed modules.
- `src/ts/bootstrap.serviceWorker.test.ts` runs `loadData` over a store-backed server with a fake
  `navigator.serviceWorker`, `fetch`, `location.reload`, and `sessionStorage`.
- `src/ts/bootstrap.safeBoot.test.ts` runs safe boot through the real `loadData`; `src/ts/safeBoot.test.ts` runs the
  controller.
- Boot cache: `src/ts/storage/tests/bootCache.test.ts` and `src/ts/storage/tests/bootCacheServer.test.ts`; see
  [ownership and cache behavior](resource-sync.md#boot-cache).
- `src/ts/router/router.test.ts` runs the router against a fake `HistoryPort` with the real store graph and Svelte
  effects, and `browserHistory` against happy-dom and a fake Navigation API. `server/src/tests/app.test.ts` covers the
  client-route fallback.
- `src/ts/observer.test.ts` covers `startObserveDom` under happy-dom with an `Audio` stub and fake timers. Mutation
  records are delivered with `takeRecords()` because happy-dom's own timer is not faked.
- `src/ts/keepAliveAudio.test.ts` runs the controller over stubbed `Audio`, `URL.createObjectURL`, and
  `navigator.mediaSession`.
- Not tested: screen precedence, platform detection, the other hotkey actions, and `Mutex` (no focused unit tests).
- Not tested: Chrome's skipping of entries pushed without a user activation, and real Navigation API behavior (checked
  by hand).
- Not tested: whether Chrome shows the tab as playing audio (checked by hand).

## Known Hazards

### Limitations

- Safe boot shares its attempt record across tabs, but concurrent writes are not atomic and a settled boot clears only
  its own record. Decision: D5 and D6 of RisuNest Small Wins ([archive](../archived-plan/README.md)).
- A plugin that throws while starting fails every boot it runs in, so a normal start with it enabled is safe again every
  third boot until it is fixed or disabled. Decision: D5 and D6 of RisuNest Small Wins
  ([archive](../archived-plan/README.md)).
- The router never waits for navigation or traverses to an entry the Navigation API does not list. Decision: the
  transition model in `src/ts/router/router.svelte.ts`.
- A browser back can do nothing after the browser drops an entry, and the URL then stays behind until another store
  change. Decision: the transition model in `src/ts/router/router.svelte.ts`.
- Overlapping back actions, script history writes, and router transitions have no defined winner. Decision: the
  transition model in `src/ts/router/router.svelte.ts`.
- Without the Navigation API, the router does not traverse back to earlier entries. Decision: the transition model in
  `src/ts/router/router.svelte.ts`.
- A back and forward within settings can leave a close replacing the current entry instead of returning to the prior
  base. Decision: layer entries retain their base route in `src/ts/router/router.svelte.ts`.
- A back pressed before any interaction on a directly opened settings or grid link leaves the app, like any first page.
  Decision: the router adds the root entry only at the first activation in `src/ts/router/router.svelte.ts`.
- BGM stop detection is marker-based. If a message re-render keeps its BGM marker out of the DOM for more than 1 s (for
  example a slow re-parse), the track stops and restarts from the beginning. Decision: `BGM_STOP_GRACE_MS` in
  `src/ts/observer.svelte.ts`.

### Gotchas

- `src/etc/patchNote.ts` has no importers; it does not drive the current release UI.
- `isInStandaloneMode` has no consumers. `bootstrap.ts` recomputes standalone mode locally before calling
  `navigator.storage.persist`.
- The `ReloadGUIPointer` subscriber in `stores.svelte.ts` skips its first call: `subscribe` calls back at once while the
  module is still evaluating, and `stores.svelte.ts` and `parser/transformClient.ts` import each other, so that call
  could reach `resetTransformEffects` before `transformClient`'s bindings exist. Keep the skip while the cycle remains
  (`stores.importOrder.test.ts`).
