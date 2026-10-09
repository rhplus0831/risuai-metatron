# URL Routes Plan

Status: slices 1–2 done (2026-10-09), slice 3 done on the untracked-back
history model and the accepted risks (2026-10-10), slice 4 built with its
unit tests and slice 5 (the docs) done (2026-10-10). Open: the manual
checks under Tests, H1's on Chrome desktop, Android Chrome, and the
Android PWA among them; the plan closes when they pass (or H1's fallback
is decided). `docs/structure/app-shell.md` now describes the shipped
router.

Give each screen an address. The browser's history then follows what the
user sees: reload keeps the screen, the browser and mobile back buttons
work, and a screen can be linked.

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
   grid, or going up from a sub-page, goes back in history instead of
   pushing the screen underneath again. So the in-app close button and the
   browser's back button do the same thing, and opening and closing
   settings repeatedly does not grow the history. Only where the router can
   confirm the entry it goes back to (decision 8); otherwise the close
   replaces the current entry.
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

Confirmed 2026-10-10:

8. **The router does not track its own back.** A back the router starts is
   handled like the user pressing the back button: whatever entry it lands
   on is applied to the stores. The router keeps no pending state, waits
   for nothing, and uses no timer. The browser gives no reliable way to tell
   the router's own traversal from another one, or to know that an entry
   still exists (Accepted risks), so the limits this leaves are accepted
   and listed instead of engineered around.

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
    Only while the browser still holds that entry (confirmed 2026-10-09):
    browsers cap the session history and drop the oldest entries, so an
    entry the router remembers can be gone. Then the navigation is a push,
    or the replace R1 and R4 call for. "Holds" means the Navigation API
    lists the entry directly beneath as an entry of this document whose URL
    is readable and equals the target (2026-10-10). The check is a hint, not
    a guarantee (A2). Without the Navigation API the router cannot check,
    so it never goes back (A4).
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

## Accepted risks

Confirmed 2026-10-10. The browser does not let a page delete entries,
change any entry but the current one, learn the whole tab history, or
learn reliably that an entry was dropped at the session history cap (the
Navigation API lists only the same-origin run around the current entry;
Chromium removes capped entries from that list late, Firefox and Safari do
not report them). The router is built on what remains and accepts the
limits below.

What the router guarantees:

- **G1. It never waits.** No state blocks a history write, and no timer
  runs. A navigation that never completes leaves nothing pending.
- **G2. It never loops.** A back that does nothing is not retried; the next
  history step comes only from the next store change or browser
  navigation.
- **G3. It never leaves the app on its own.** It traverses only to an entry
  the Navigation API lists as an entry of this document whose URL is the
  route it expects. Without the Navigation API it never traverses.
- **G4. The stores stay the state, and the URL catches up.** After any
  limit below, the URL names the stores' screen again by the next settled
  store change at the latest. A limit never leaves a wrong screen that a
  click cannot fix, never writes data beyond what applying a route already
  writes (`ensureChat`), and never hides the app behind an empty screen.

The limits it accepts:

- **A1. A click during a traversal can be undone.** The landing of a back
  (the router's or the user's) is applied to the stores. A store change
  made between the start of the back and its landing (usually within a
  frame) is replaced by the landed screen.
- **A2. A back can silently do nothing.** The entry beneath can be dropped
  between the check and the traversal (the cap; Chromium's list lags it).
  The stores already show the target, so the screen is right, but the URL
  stays one step behind until the next store change. That stale entry stays
  in the history.
- **A3. Simultaneous navigations have no defined winner.** When the user's
  back or forward, another script's `pushState`/`replaceState`, an address
  bar fragment change, and a router write or traversal overlap, the screen
  ends as the last applied event says; both intents are not preserved.
  Another script's `pushState`/`replaceState` is not observed at all (it
  fires no `popstate`); the router overwrites it at the next store change.
- **A4. Without the Navigation API (iOS before 26.2, older Firefox) the
  router never goes back.** Base routes push or replace, and a layer close
  replaces the layer entry with the base route. The history then grows,
  and a back press after closing a layer shows the screen that was under
  it again (an entry with the same screen).
- **A5. The history is only as deep as the browser keeps it.** The oldest
  entries disappear at the cap (50 in Chromium and Firefox, 100 in WebKit).
- **A6. The router's own landing is applied again.** Applying the route the
  stores already show repeats `applyRoute`'s writes with the same values;
  `selectCharacter` with the selected id notifies no listener.
- **A7. Entries pushed without a user activation can be skipped by the
  browser's back button** (H1).

Review standard: a finding that falls within A1–A7 and stays within G1–G4
is reported as `minor`. A finding is `blocking` when it breaks G1–G4 or
shows an effect larger than the limit describes.

## History model

Each entry the app creates has this state:

```ts
type RouteState = {
  v: 1;
  /** For a layer entry: how many entries above its base route (1 = directly on it); 0 for a base route. */
  layerDepth: number;
  /** For a layer entry: the base route under it, applied first on a reload. */
  base?: string;
  /** For a layer entry whose base changed while it was open (R6): the layer entries beneath can name an older base. */
  rebased?: true;
  /** For a layer entry shown at boot without its base entry beneath: the base entry is still to be inserted (H1). */
  rootPending?: true;
};
```

`history.state` survives a reload. What is underneath comes only from the
Navigation API (`navigation.entries()` around `currentEntry`), as a hint
checked right before a traversal; the router keeps no record of its own
(a record by URL, then by entry id, was tried in slice 3 and named entries
the browser had dropped).

- **Boot (replaces `selectCharacter(null)` at the end of `loadData`).** The
  router starts after `loadedStore` is set and the plugins have loaded.
  - The entry has `v: 1` (a reload, or back/forward from outside the app):
    apply it. For a layer entry, apply its `base` first, then the layer, so
    pages that read the selected character see the right one.
  - The entry has no state, and the URL is a base route: write the state
    with `replaceState` and apply the URL.
  - The entry has no state, and the URL is a layer: apply `/` and the
    layer, and stamp the entry `rootPending` with `base: "/"`. The base
    entry is inserted under it at the first user activation (decision 5,
    H1). An entry still `rootPending` at a reload waits again.
  - The URL is a base route and an import that finished before the router
    started opened settings (`characterURLImport` is not awaited): the
    layer stays open over that base and the entry waits for its base entry
    the same way.
  - Anything else: replace with `/` (R4).
- **Applying a URL** (boot and every `popstate`) sets the stores, then
  replaces the entry with the stores' route. That replace carries every
  correction of R4 and writes the canonical path without a query or hash.
  For a chat it calls `selectChat` before `selectCharacter`, so the
  selection loads the requested chat rather than the previous one.
- **The sync effect** (`$effect.root`) watches the route derived from the
  stores. A change that settles (several setters run in one handler: the
  sidebar's `reseter()`, `selectCharacter(null)`, then
  `PlaygroundStore.set(0)`) produces one history step, chosen by R1:
  nothing when the URL already shows it; R4's replace when the entry's
  character is gone; a back when the target is the confirmed entry beneath;
  R1's chat-switch replace; else a push.
- **A back** (decision 8): the router reads the entry directly beneath from
  the Navigation API (an entry of this document, `url` readable and equal
  to the target) and calls `navigation.traverseTo(key)`, ignoring its
  promises. Nothing else changes: the stores already show the target, and
  the landing's `popstate` is applied like any other (A1, A6). A traversal
  that does nothing leaves the URL behind (A2).
- **Every `popstate` is applied.** The router does not ask who started the
  traversal. A base entry closes both layers. A layer entry applies its
  `base` first, then the layer.
- **Opening a layer** pushes it with `layerDepth: 1` and the stores' base.
  A settings page opened on a narrow screen (a remembered page, the HypaV3
  modal, an import, a link at the root insertion) pushes the list under
  it first (depths 1 and 2), so the page's close returns to the list
  (decision 6).
- **Closing a layer** (settings off, grid off). When the
  Navigation API lists the entry `layerDepth` below as an entry of this
  document whose URL is the base route the stores show (the layer's
  `base`, unless R6 changed it in the same step), the router traverses to
  it.
  Otherwise (the entry is gone, it is another document's, or there is no
  Navigation API) it replaces the layer entry with the base route and
  `layerDepth: 0`. Another entry of the same layer can still remain below
  (the mobile settings list under a page), so a later back can reach it.
- **R6. The base route changes while a layer is open** (revised
  2026-10-10). For example, a character picked in the grid (the grid stays
  open), or the Home hotkey pressed in settings. The layer entry's `base`
  is replaced with the new base route. Closing the layer then finds a
  different URL beneath (the old base), so it does not go back: it
  replaces the layer entry with the new base route. A back would land on
  the old base and be applied over the new one. The old base stays in the
  history beneath. The entry is marked `rebased`, and the router no longer
  goes back to a layer entry beneath it (the mobile list under a page),
  which names the old base: the move replaces instead. A base change in
  the same step as the move counts the same. A `popstate` that lands on a
  layer entry above depth 1 marks it `rebased` too: while it was a forward
  entry, R6 can have changed the entries beneath, and the router cannot
  read their state. So after a back and a forward, the page's close
  replaces (the list entry stays beneath) instead of going back.
- **R4 under a layer.** When the layer entry's `base` names a removed
  character and nothing is selected any more, the base goes home as it
  does without a layer (the playground value and the realm flag are
  cleared), then R6 writes it into the entry.
- **A move inside a layer** goes back when the entry is above depth 1, not
  `rebased`, and the entry beneath shows the target; pushes for R1's
  in-settings pushes (the mobile list → a page, the prompt preset → its
  template); else replaces at the same depth. Switching between settings
  and the grid replaces (R3) before any back is considered.
- **`popstate` from outside the scheme** (no `v: 1`) on a base URL is
  applied and stamped. On a layer URL (an address-bar fragment change) the
  layer is applied over the stores' base: inserting a base entry there
  would cut the forward entries.
- **The settings list on mobile.** On a screen narrower than 700 px, the
  list (`/settings`, depth 1) and a page (`/settings/:page`, depth 2) are
  separate entries.
  - The close button on a page sets index `-1`. That target is the entry
    beneath, so the router goes back (R1).
  - The list's close button closes the layer by the rule above, from depth
    2 on a page or depth 1 on the list.
  - Escape and the settings hotkey (`hotkey.ts`) set `settingsOpen` to
    false and close the same way. Escape also closes the grid (slice 4
    added it; before, only the grid's button did).
- **One layer at a time (R3).** Open settings closes the grid under it, so
  closing settings and going back both show the base route.
- **Store corrections without a history step.** The playground value 2
  with nothing selected becomes 1, the settings list on a screen 700 px or
  wider becomes the model page (R4's canonical `/settings/model`;
  `Settings.svelte` itself picks the model page only from 900 px, at
  mount), and open settings closes the grid. They keep the route, so they
  take no step of their own.

A small `HistoryPort` interface wraps the browser so the unit tests can run
a fake: `path` and `state` (read live), `push`, `replace`, `entryBelow(n)`
(the Navigation API entry `n` below as `{ key, path }` when it is an entry
of this document with a readable URL, else null; always null without the
Navigation API), `traverse(key)` (fire and forget), and a `popstate`
subscription.

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
- `src/ts/router/router.svelte.ts` (slice 3): `startRouter()` (boot), the
  sync effect, the `popstate` handler, and `HistoryPort`. It reads the
  writable stores through `fromStore`. Kept from the first slice 3 build:
  - `routeOfState` derives the base route: a selected character is its chat
    (`§playground` is the playground chat), else the playground value
    (`0` is home or realm by `OpenRealmStore`; a value without a slug is the
    menu).
  - `applyRoute` sets every store a route depends on (the playground value
    and `OpenRealmStore` too), calls `ensureChat` like `changeChar`, and
    does not wait for a running generation (as the character hotkeys).
    A missing character applies home (R4), the playground chat's too.
  - R4's correction of a removed character: when that left nothing
    selected, the stores go home first (the playground value and the realm
    flag are cleared too), and the entry is replaced. A correction can
    leave two adjacent entries with the same URL; that is preferred to
    keeping the removed character's entry.
  - The playground value 2 with nothing selected (the Home hotkey from the
    playground chat clears only the selection, which left an empty screen)
    is set to 1, the menu its URL names, before the route is written.
  - Slice 4 (2026-10-10): the layer routes, `layerDepth`, `base`,
    `rebased`, `rootPending`, and the corrections above. The sync effect's
    key is the shown route and the base route, so R6 sees a base change
    under an open layer. The root insertion listens in the capture phase
    on `window` for the events that give a user activation (`keydown`
    other than Escape, `mousedown`, a mouse `pointerdown`, a touch or pen
    `pointerup`, `touchend`, and `click`), trusted only, and checks
    `navigator.userActivation` where it exists. The listeners go when the
    entry no longer waits (a close, a push, a `popstate`) and on stop.
  - Rebuilt for decision 8 (2026-10-10): no pending traversal, no
    ownership token, no `navigate` listener. One `browserHistory` object
    with its own live `path` and `state` getters (the first build spread an
    object with getters and froze them); without the Navigation API its
    `entryBelow` is always null, so it never goes back (A4). `traverse`
    ignores both `traverseTo` promises. The port is created after the
    started guard, and the stop removes the `popstate` listener.
  - The sync effect depends on the formatted route, not on the stores it
    reads: a store change that keeps the route (a chat list reordered or
    updated from another tab, the playground value 2 set to 1) takes no
    step. Otherwise, while the URL is behind a back, each such change would
    start the same back again.
- `src/ts/bootstrap.ts`: the end of `loadData` calls `startRouter()` instead
  of `selectCharacter(null)`.
- `src/ts/characterCards.ts`: R5. The hash is read when
  `characterURLImport` starts (it runs before the router, but reads the
  hash after an `await` when a `?charahub=` link is present); the consumed
  `?realm=`, `?charahub=`, and `#import=` are removed with `replaceState`.
  The other link fragments (`#import_module=`, `#share_character`, ...)
  were never removed; the router's first write drops them now.
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
- `/settings/hotkeys` below 768 px: `Settings.svelte` renders no hotkey
  page there (an existing gap that a direct link now reaches).

## Hazards

- **H1. Chrome skips entries pushed without a user gesture.** Chrome's
  history manipulation intervention marks an entry as skippable when the
  page pushes a new entry over it without a user activation. The browser
  back button and Android's system back then skip that entry. The root
  entry that boot inserts under a directly opened layer is exactly such an
  entry, so back could skip `/` and leave the app.
  - Mitigation: at boot, show the layer while the URL stays a single entry.
    Do the replace-with-the-base and push-the-layer step on the first
    input event that gives an activation (History model). A back press
    before any interaction leaves the app, the same as any first page. A
    close before any interaction (Escape gives no activation) finds no base
    entry and replaces.
  - Check this on Chrome desktop and on Android Chrome (in a tab and in the
    installed PWA). If it still skips, fall back to the overlap form
    (decision 5).
  - Pushes made in click handlers carry an activation. Pushes made after a
    long `await` may not (for example `changeChar` after the add-character
    alert). Watch for those during manual checks.
- **H2. Traversals are asynchronous and untracked.** Between a back and its
  landing, store changes and other navigations can interleave; the router
  accepts the outcome (A1, A3) instead of tracking the traversal.
- **H3. Reload now lands inside a chat.** Boot code that assumed home at
  first paint must handle a selected character: the `onCharacterSelected`
  listeners and the chat load at boot. A deleted chat id falls back as in
  R4.
- **H4. Two tabs.** Each tab has its own URL and selection, as today.
  `writeSelectionPreference` (the per-character last chat in
  `localStorage`) is unchanged. A chat in the URL wins over it.
- **H5. Session history cap and the Navigation API.** Browsers keep a
  limited number of entries per tab and drop the oldest (A2, A5). Check by
  hand: the Navigation API on Safari 26.2 and later (reported as partial),
  that `entries()` and `traverseTo` behave as the History model expects;
  and that without the Navigation API base routes push and a layer close
  replaces (A4).

## Slices

1. **Route table.** `shared/routes.ts`, `src/ts/router/routes.ts`, and
   unit tests for parsing and formatting (every slug in both directions,
   encoding, unknown input). Settle the slugs for indices 7, 8, and 9.
2. **Server.** The prefix routes in `app.ts`, and a server test: route paths
   get the HTML with `__NODE__`, while `/api/...` misses and unknown paths
   return 404.
3. **Router, base routes.** The history model without layers: boot,
   `popstate`, the sync effect, R1 and R4, and R5, on decision 8 and the
   accepted risks. Bootstrap starts the router. Unit tests use the fake
   `HistoryPort`.
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
  - `router.test.ts`: with the fake history, every R1 transition, a back
    only to a confirmed entry and never without the Navigation API, every
    `popstate` applied, a back that does nothing not retried (G2) and the
    URL caught up at the next change (G4), a layer close by depth and its
    replace fallback, R6, boot with and without state, and the corrections.
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
    entry;
  - a session past the cap (60+ character switches), then back and the
    in-app navigation: no hang, the URL catches up (G1, G4).
