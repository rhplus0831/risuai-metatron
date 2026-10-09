# URL Routes Plan

Status: slices 1–2 done (2026-10-09); slice 3 is next. Give each screen an address. The browser's
history then follows what the user sees: reload keeps the screen, the
browser and mobile back buttons work, and a screen can be linked.

The stores stay the state. A new router keeps the URL and the history in
sync with them in both directions. The `{#if}` chains in `App.svelte` and
`DefaultChatScreen.svelte`, and the code that sets the stores (the sidebar,
hotkeys, plugins, imports), do not change for this plan.

## Today

There is no router (`STRUCTURE.md` U4). The screen comes from these stores:

| State                | Store                                       | Kind                                    |
| -------------------- | ------------------------------------------- | --------------------------------------- |
| Selected character   | `selection.characterId` (`selectCharacter`) | id; `null` is home                      |
| Selected chat        | `selectedChatId(chaId)` (`selectChat`)      | id, per tab; loaded on demand           |
| Settings open / page | `settingsOpen`, `SettingsMenuIndex`         | boolean, magic number (`-1` = the list) |
| Character grid       | `gridOpenStore`                             | boolean                                 |
| Realm explore (home) | `OpenRealmStore`                            | boolean                                 |
| Playground           | `PlaygroundStore`                           | magic number (`0` none, `1` the menu)   |

The only URL use today is the import at boot (`characterURLImport` in
`src/ts/characterCards.ts`: `?realm=`, `?charahub=`, `#import=`). It removes
its parameter with `pushState`, or by assigning `location.hash`, which adds
a history entry each time.

## Product decisions

Confirmed 2026-10-09:

1. **The stores stay the state (approach A).** The router serializes them to
   the URL and applies a URL to them. It does not replace them.
2. **Reload restores the screen, including the selected character.** This
   reverses the Phase 6 slice 5 rule "a reload starts at home"
   (`selection.svelte.ts`). The URL is per tab, so the selection stays per
   tab.
3. **History mode** (`/settings/model`, not `#/settings/model`). The server
   serves the client for the route paths (Server).
4. **Closing goes back in history.** Closing settings or the character
   grid, or going up from a sub-page, calls `history.back()` (or `go(-n)`).
   It does not push the screen underneath again. So the in-app close button
   and the browser's back button do the same thing, and opening and closing
   settings repeatedly does not grow the history.
5. **A settings page opened directly gets a root entry inserted under it.**
   When a settings or grid URL is the first entry (a typed link, a
   bookmark, a new tab), the router puts `/` under it, so closing goes back
   to home and does not leave the app. Use the overlap form
   (`/chat/x?settings=model`) only if the insertion fails the check in
   Hazards H1.
6. **Mobile back is a navigation.** Android's system back and the swipe
   gesture go through `popstate` like the browser button. From the settings
   page it returns to the settings list, from settings to the screen
   underneath, and from a playground tool to the playground menu.
7. **Overlays are not routes.** Alerts, popups, modals (HypaV3, the preset
   and persona lists, Realm info), the side panel (`CharConfigSubMenu`,
   `botMakerMode`), and the sidebar's open state stay out of the URL.

## Routes

`chaId` and `chatId` are encoded with `encodeURIComponent`. The URL holds
only ids, never names.

| Screen                 | Path                       | Stores                                                     | Kind  |
| ---------------------- | -------------------------- | ---------------------------------------------------------- | ----- |
| Home                   | `/`                        | character `null`, playground `0`, realm off                | base  |
| Realm explore          | `/realm`                   | character `null`, realm on                                 | base  |
| Chat                   | `/chat/:chaId/:chatId`     | `selectChat(chaId, chatId)`, then `selectCharacter(chaId)` | base  |
| Playground menu        | `/playground`              | character `null`, playground `1`                           | base  |
| Playground tool        | `/playground/:tool`        | character `null`, playground per slug below                | base  |
| Playground chat        | `/playground/chat/:chatId` | character `§playground`, playground `2`                    | base  |
| Character grid         | `/characters`              | `gridOpenStore` on, over the base                          | layer |
| Settings list (mobile) | `/settings`                | `settingsOpen`, index `-1`                                 | layer |
| Settings page          | `/settings/:page`          | `settingsOpen`, index per slug below                       | layer |

A **base** route is a screen of its own. A **layer** opens over a base
route and hides it. The layer's URL does not say which base route is
underneath: the history entry's state does (History model).

Settings slugs (`SettingsMenuIndex`):

| Slug              | Index | Page                    |
| ----------------- | ----- | ----------------------- |
| `model`           | 1     | `ModelSettings`         |
| `connections`     | 18    | `ModelProfilesSettings` |
| `api-keys`        | 17    | `ApiKeysSettings`       |
| `prompt`          | 16    | `PromptPresetSettings`  |
| `prompt-template` | 13    | `PromptSettings`        |
| `persona`         | 12    | `PersonaSettings`       |
| `bot`             | 2     | `OtherBotSettings`      |
| `display`         | 3     | `DisplaySettings`       |
| `language`        | 10    | `LanguageSettings`      |
| `accessibility`   | 11    | `AccessibilitySettings` |
| `modules`         | 14    | `ModuleSettings`        |
| `plugins`         | 4     | `PluginSettings`        |
| `user`            | 0     | `UserSettings`          |
| `hotkeys`         | 15    | `HotkeySettings`        |
| `advanced`        | 6     | `AdvancedSettings`      |
| `thanks`          | 77    | `ThanksPage`            |

Indices 7 (`Communities`), 8 (`GlobalLoreBookSettings`), and 9
(`GlobalRegex`) get no slug: `Settings.svelte` still renders them, but
nothing sets those indices (checked in slice 1). An index without a slug
has no route (`settingsPageOf` returns null).

Playground slugs (`PlaygroundStore`): `embedding` 3, `tokenizer` 4,
`syntax` 5, `jinja` 6, `image-gen` 7, `parser` 8, `subtitle` 9,
`image-translate` 10, `translation` 11, `mcp` 12, `docs` 13, `inlays` 14,
`tool-conversion` 101.

The slug tables are the only place that knows the magic numbers. The
numbers stay in the components; replacing them with named constants is
optional cleanup, not part of this plan.

## Detailed decisions

Confirmed 2026-10-09 as proposed. The rest of the plan refers to them by label.

- **R1. Which changes push a new entry and which replace the current one.**
  - Push: switching characters, home ↔ realm, opening the playground menu or
    a tool, opening a layer, PromptPreset → prompt template, and on mobile
    the settings list → a page.
  - Replace:
    - switching chats within the same character, so moving through many
      chats does not fill the history;
    - switching settings pages on desktop, where the list and the page are
      shown together;
    - corrections (R4).
  - Back: any navigation whose target is the URL of the app entry directly
    beneath the current one. This covers the playground's back arrow, the
    prompt template's back button, and the mobile settings page → list.
  - Layer close is its own rule (History model).
- **R2. The router reads changes from the state, not from the caller.** The
  sync effect compares the route before and after a settled change and
  picks push, replace, back, or close from the table in R1. No setter call
  site changes. A caller whose intent the table gets wrong can add a hint,
  `withNavigation("replace", fn)`. Add a hint only when the case comes up,
  not in advance.
- **R3. One layer at a time.** Opening a layer while another is open
  replaces the current entry and keeps its depth. `App.svelte` already
  shows only one: settings wins over the grid.
- **R4. Corrections replace.** These cases use `replaceState` and never
  add an entry:
  - a URL that names no record: an unknown `chaId`, or an unknown slug
    goes to `/`; an unknown `chatId` goes to the character's selected chat;
  - a selected character that is removed (the membership hook in
    `selection.svelte.ts` sets home);
  - canonical forms: `/chat/:chaId` becomes `/chat/:chaId/:chatId`, and
    `/settings` on a screen 700 px or wider becomes `/settings/model`,
    because `Settings.svelte` picks the model page there.
- **R5. Query parameters and the hash are consumed at boot.** The
  `characterURLImport` code switches from `pushState` and assigning
  `location.hash` to `replaceState`. Route URLs carry no query parameters.

## History model

Each entry the app creates has this state:

```ts
type RouteState = {
  v: 1;
  /** URLs of the app's entries below this one, oldest first, capped at 50. */
  below: string[];
  /** For a layer entry: how many entries above its base route (1 = directly on it); 0 for a base route. */
  layerDepth: number;
  /** A base route chosen while the layer was open (R6). */
  nextBase?: string;
};
```

`history.state` survives a reload, so the router knows what is underneath
even after a reload.

- **Boot (replaces `selectCharacter(null)` at the end of `loadData`).** The
  router starts after `loadedStore` is set and the plugins have loaded.
  - The entry has `v: 1` (a reload, or back/forward from outside the app):
    apply it. For a layer entry, apply the base route
    `below[below.length - layerDepth]` first, then the layer, so pages
    that read the selected character see the right one.
  - The entry has no state, and the URL is a base route: write the state
    with `replaceState` and apply the URL.
  - The entry has no state, and the URL is a layer: replace the entry with
    `/` and push the layer over it (decision 5; when to do this: H1). Then
    apply `/` and the layer.
  - Anything else: replace with `/` (R4).
- **Applying a URL** sets the stores and the selection inside an `applying`
  guard, so the sync effect does not echo the change back as a new entry.
  For a chat it calls `selectChat` before `selectCharacter`, so the
  selection loads the requested chat rather than the previous one. Check
  this order against `onCharacterSelected` in slice 3.
- **The sync effect** (`$effect.root`) watches the route derived from the
  stores. A change that settles (several setters run in one handler: the
  sidebar's `reseter()`, `selectCharacter(null)`, then
  `PlaygroundStore.set(0)`) produces one history step, chosen by R1.
- **Closing a layer** (settings off, grid off) calls
  `history.go(-layerDepth)`. The `popstate` that follows applies the base
  route.
- **R6. The base route changes while a layer is open.** For example, a
  character picked in the grid (the grid stays open), or the Home hotkey
  pressed in settings. The new base route is written to the current
  entry's `nextBase`. When the layer closes, the router goes back as usual.
  On that `popstate` it replaces the base entry with `nextBase` and
  applies `nextBase` instead of the old base, so the old screen never
  flashes.
- **Pending traversal.** Between a `back`/`go(-n)` call and its `popstate`,
  the sync effect waits. After the `popstate`, the router compares the
  stores with the entry it landed on. If something changed in between (a
  fast second click), that difference is pushed or replaced by R1.
- **`popstate` from outside the scheme** (no `v: 1`) is treated like a boot
  entry without state.
- **The settings list on mobile.** On a screen narrower than 700 px, the
  list (`/settings`, depth 1) and a page (`/settings/:page`, depth 2) are
  separate entries.
  - The close button on a page sets index `-1`. That target is the entry
    beneath, so the router goes back.
  - The list's close button closes the layer with `go(-2)` from a page or
    `go(-1)` from the list.
  - Escape and the settings hotkey (`hotkey.ts`) set `settingsOpen` to
    false and close the same way.

A small `HistoryPort` interface (`state`, `url`, `push`, `replace`, `go`,
and a `popstate` subscription) wraps `window.history`, so the unit tests
can run a fake history with asynchronous `popstate`.

## Server

- `shared/routes.ts`: `CLIENT_ROUTE_SEGMENTS` (the first path segments
  `chat`, `playground`, `realm`, `characters`, `settings`) and
  `isClientRoutePath`. There is no DOM type, as `shared/` requires.
- `server/src/app.ts`: a `GET *` handler next to `app.get("/")` serves
  `serveIndex` when `isClientRoutePath` matches and passes the request on
  otherwise. Every path under those five segments gets the client (the
  client rejects one that names no screen); any other unknown path, an
  `/api` miss, or an asset miss still returns 404. The
  `__NODE__` injection is unchanged. The route paths are unauthenticated,
  like `/`.
- `public/` has no `chat`, `settings`, `playground`, `realm`, or
  `characters` entries, so `serveStatic` does not collide with them.
- The Vite dev server (`appType` is the default `spa`) already falls back to
  `index.html` and runs the `risu-node-flag` transform on it. Verify this
  by hand.
- The service worker (`public/sw.js`) handles only `/sw/*`, and the
  manifest's `start_url` stays `/`. Neither needs a change.
- Every built and public asset path is absolute (Vite `base` is the default
  `/`, and `index.html` uses `/...`), so deep paths load the same bundle.

## Client

- `src/ts/router/routes.ts` (slice 1): the slug tables (`SETTINGS_PAGES`,
  `PLAYGROUND_TOOLS`), the `Route` union, `formatRoute(route) → path`,
  `parseRoute(path) → Route | null`, and `settingsPageOf`/`playgroundToolOf`
  (store value → slug). Pure functions. Mapping the stores to a `Route` (for
  example the `§playground` character with playground `2` to
  `playgroundChat`) is the router's job in slice 3.
- `src/ts/settingsMenu.ts` (slice 1): the named `SettingsMenuIndex` values,
  moved out of `stores.svelte.ts` (which re-exports them) so the route table
  does not import the store graph.
- `src/ts/router/router.svelte.ts`: `startRouter()` (boot), the sync
  effect, the `popstate` handler, `HistoryPort`, and the pending-traversal
  logic. It reads the writable stores through `fromStore`.
- `src/ts/bootstrap.ts`: the end of `loadData` calls `startRouter()` instead
  of `selectCharacter(null)`.
- `src/ts/characterCards.ts`: R5.
- `src/ts/storage/selection.svelte.ts`: update the comments ("a reload
  starts at home"). The behavior stays: the selection is not stored, and
  the URL restores it.

## Out of scope

- Closing the mobile sidebar or a modal with back. That would need history
  entries with no path change. It is a follow-up and goes against
  decision 7.
- Routes for `CharConfigSubMenu` tabs, `CustomGUISettingMenuStore`,
  `WelcomeRisu` (the first-setup screen still wins over any route), plugin
  settings menus (callback-based), and message anchors.
- Replacing the magic numbers in the components.

## Hazards

- **H1. Chrome skips entries pushed without a user gesture.** Chrome's
  history manipulation intervention marks an entry as skippable when the
  page pushes a new entry over it without a user activation. The browser
  back button and Android's system back then skip that entry. The root
  entry that boot inserts under a directly opened layer is exactly such an
  entry, so back could skip `/` and leave the app.
  - Mitigation: at boot, show the layer while the URL stays a single entry.
    Do the replace-with-`/` and push-the-layer step on the first
    `pointerdown` or `keydown`, which has an activation. A back press
    before any interaction leaves the app, the same as any first page.
  - Check this on Chrome desktop and on Android Chrome (in a tab and in the
    installed PWA). If it still skips, fall back to the overlap form
    (decision 5).
  - Pushes made in click handlers carry an activation. Pushes made after a
    long `await` may not (for example `changeChar` after the add-character
    alert). Watch for those during manual checks.
- **H2. `history.go` is asynchronous.** Every navigation decision during a
  pending traversal has to be deferred (History model). A missed case
  shows up as a duplicate entry or a screen that flashes.
- **H3. Reload now lands inside a chat.** Boot code that assumed home at
  first paint must handle a selected character: the `onCharacterSelected`
  listeners and the chat load at boot. A deleted chat id falls back as in
  R4.
- **H4. Two tabs.** Each tab has its own URL and selection, as today.
  `writeSelectionPreference` (the per-character last chat in
  `localStorage`) is unchanged. A chat in the URL wins over it.

## Slices

1. **Route table.** `shared/routes.ts`, `src/ts/router/routes.ts`, and
   unit tests for parsing and formatting (every slug in both directions,
   encoding, unknown input). Settle the slugs for indices 7, 8, and 9.
2. **Server.** The prefix routes in `app.ts`, and a server test: route paths
   get the HTML with `__NODE__`, while `/api/...` misses and unknown paths
   return 404.
3. **Router, base routes.** The history model without layers: boot,
   `popstate`, the sync effect, R1 and R4, and R5. Bootstrap starts the
   router. Unit tests use the fake `HistoryPort`.
4. **Layers.** Settings and the grid, `layerDepth`, the root insertion
   (with H1's activation deferral), R6, and the mobile settings list. Unit
   tests, then the manual checks.
5. **Docs.** `STRUCTURE.md` U4, `app-shell.md` (Flows: boot step 5 and
   screen selection; State; Recipes: "Add a top-level screen" now includes
   a route), and the `selection.svelte.ts` comments. Close out this plan in
   `docs/plan/README.md`.

## Tests

- Unit tests:
  - `routes.test.ts`: the route table.
  - `router.test.ts`: with the fake history, every R1 transition, a layer
    close by depth, R6, the pending traversal under a quick second click,
    boot with and without state, and the corrections.
- Server: `server/src/tests/` gets the prefix route test.
- Manual, in Chrome desktop, Android Chrome, the Android PWA, and iOS
  Safari:
  - reload in a chat, in a settings page, and in the grid;
  - paste a settings URL into a new tab, then close settings: you land on
    home;
  - close settings and the grid with the in-app button, Escape, and back;
  - on mobile: page → list → closed with back;
  - playground tool → menu with back;
  - pick a character in the grid, then close the grid;
  - a URL with a deleted character;
  - the `?realm=` and `#import=` links, which leave no extra history
    entry.
