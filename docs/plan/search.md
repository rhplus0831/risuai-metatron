# Search Plan

Status: planned 2026-10-20 at `c7628a0bb`; landed 1 (`a6082b735`), 2a (`ceeb22d92`), 4a (`016028c47`), 2b (`89bd9a57a`), 2c (`fd2f81040`), 3a (`faaeba64f`) and 2d (`b9dcbbe20`) on 2026-10-20. Source: `docs/research/haejeok-feature-survey.md`
items F1 (settings search), F2 (`color-scheme`), A3 (message search across chats) and A4
(Korean-aware matching), and `docs/research/pocketrisu-risubard-picks.md` §1.2 item 9
(settings search and deep links). HaejeokRisuai (`/home/codex/HaejeokRisuai`) is a read-only
reference: port concepts, not code. The plan was challenged against the code by a Sol
verification pass (opus-lite); its findings are folded in below. Line numbers are approximate;
the identifiers are the anchors. Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply, and a slice that edits a file
another guide owns (STRUCTURE.md Path Ownership) reads that guide's `Coupling` and `Invariants`
too. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow` for one marked
_hard_. Each slice ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent --exclude ".claude/**"` and the owning guide's focused checks (its
`Tests` section), and updates the owning guide where it adds a file or changes a documented
contract. Tests follow the two-gate rule (STRUCTURE.md V3): no wall-clock, sleep or scheduler
dependence in the default gate; control the clock, inject the limit, or use a latch.

The `heap-memory-reduction` branch this plan was written beside has since merged into
`metatron` (`b122ae132`, plan archived at `fd13d5381`), so no slice waits on that merge. The plan
was still sized so that no slice edits its files (`src/ts/storage/*`, `src/ts/stores.svelte.ts`,
`src/ts/characters.ts`, `src/ts/assetList.ts`, `src/ts/parser/parser.svelte.ts`,
`src/lib/SideBars/CharConfig.svelte`, `src/ts/process/modules.ts`, `src/ts/util.ts`,
`server/src/prompt/assemble.ts`, `server/src/prompt/runner.ts`): slices import from them
(`selectChat`, `authFetch`, `settingsOpen`, `SettingsMenuIndex`, `gridOpenStore`) and set their
stores. Keep that scope: a slice that finds it must edit one of them stops and records why, so the
orchestrator can widen the slice deliberately instead of the slice drifting into shared files.

## Problem

1. **Native controls ignore the light schemes.** `updateColorScheme`
   (`src/ts/gui/colorscheme.ts`) sets the `--risu-theme-*` variables and
   `ColorSchemeTypeStore`, but nothing declares `color-scheme`, so native `<select>` popups,
   scrollbars, date inputs and autofill render in the browser's default (OS) scheme: dark
   popups on the `light` scheme on a dark OS, or light popups on dark schemes on a light OS.
   `src/styles.css` `:root` defaults to the dark Dracula palette before boot.
2. **List filters are plain substring checks, and two lists have none.** The character catalog
   (`src/lib/Others/GridCatalog.svelte` `formatChars`, and `src/lib/Mobile/MobileCharacters.svelte`
   `normalizeSearch`) lowercases and strips spaces. The module lists
   (`Setting/Pages/Module/ModuleSettings.svelte`, `ModuleChatMenu.svelte`) and the persona page's
   linkable-module filter (`PersonaSettings.svelte`) use `toLowerCase().includes`. The sidebar chat
   list (`src/lib/SideBars/SideChatList.svelte`) and the lorebook list
   (`src/lib/SideBars/LoreBook/LoreBookList.svelte`) have no text filter at all. None of them match
   Korean the way Korean users type: initial consonants (ㅎㅈ for 해적), or the half-composed last
   syllable an IME shows while typing (해저 on the way to 해적).
3. **Settings cannot be searched.** The registry is declarative (`src/ts/setting/*SettingsData.ts`,
   `SettingItem.keywords` marked "for future search feature" in `types.ts`), and
   `getFullSettingsData(searchTerm)` (`src/ts/setting/utils.ts`) filters it by label and keywords,
   but there is no UI and no way to open the page, tab, section or accordion that holds an item.
   The items do not know their page: each page renders its own leaf arrays or sections, some inside
   handwritten accordions or conditional branches (`ModelSettings.svelte` Additional Params,
   `Model/ModelProfileEditor.svelte` Chat Formatting, `MemorySettings.svelte`'s SupaMemory branch).
4. **Messages cannot be searched.** Chats live on the server (`server/src/data/chatStore.ts`, table
   `messages`, one row per message, the message JSON in `data`; text in `$.data`). The tab holds one
   loaded chat at a time, so a client-side search over all chats is impossible without loading them
   all. There is no search route. The chat screen's jump (`DefaultChatScreen.svelte`
   `scrollToMessage(index)`, fed by `ScrollToMessageStore` from `BookmarkList.svelte`) addresses a
   message by index and keeps an element across awaits.

## Approach

1. Declare `color-scheme` on the document root, from the scheme's `type` (slice 1).
2. One shared matcher, `src/ts/util/koreanSearch.ts`, built on `es-hangul` (slice 2a). It answers
   "does this text match this query" and a score; the list filters use the boolean (they keep
   their order), settings search uses the score. Slices 2b–2d swap the existing filters to it and
   add the two missing filters (chat list, lorebook list).
3. Settings search (slices 3a, 3b): a location table that maps every registry item to one
   canonical destination (page as `SettingsMenuIndex`, tab, section, handwritten accordion), with
   an availability predicate that covers the item's own condition and its parents' conditions; a
   ranked search over item labels (current language and English), keywords, section titles, page
   and tab names; and `openSetting(id)`, which records a jump and remounts the target page (the
   page is already keyed in `Settings.svelte`), so mount-time consumers (`takeRequestedDisplayTab`,
   `Accordion`'s `startOpen`) apply on every jump, including one to the page already shown. The UI
   is a search field at the top of the settings navigation.
4. Message search (slices 4a, 4b): a server route that scans `messages` with `LIKE` over
   `json_extract(data, '$.data')` in small batches with a yield between batches, bounded per
   request, paged by a best-effort keyset cursor; a client panel that lists hits with a plain-text
   snippet, opens the hit's chat (`openPinnedChat`, leaving the catalog) and scrolls to the message
   by `{ ref, messageId }`, cancelled when the selection changes.

Measured for the A3 index choice (2026-10-20, synthetic 100,000 messages, 175 MB of message JSON,
Korean and English text; host Node 24.21.0 and `docker run node:24-slim` Node 24.22.0, both
SQLite 3.53.4 with `ENABLE_FTS5`; the verifier reproduced the version, the FTS5 flag and the
two-character trigram limit, not the timings):

| Approach                                  | Build  | Extra storage | Query                                                                           |
| ----------------------------------------- | ------ | ------------- | ------------------------------------------------------------------------------- |
| `LIKE` over `json_extract(data,'$.data')` | none   | none          | 250–470 ms full scan                                                            |
| `LIKE` over raw `data`                    | none   | none          | 116–294 ms (also matches JSON keys and fields)                                  |
| FTS5 `trigram` table (own content)        | 19.4 s | 448 MB (2.5x) | 0 ms for 3+ chars; a 2-char `MATCH` finds nothing, 2-char `LIKE` scans (506 ms) |
| FTS5 `unicode61`                          | 6.7 s  | ~238 MB       | token or prefix only: 해적 finds 해적이 by `해적*`, not 바다해적                |

Two-syllable Korean words (해적, 사랑) are the common query, and `trigram` cannot index them; a
batched `LIKE` scan is fast enough for one user's data and needs no index to keep consistent with
restores, snapshots and the chat write paths. So the plan ships the scan (Decision 7) and keeps an
index as a measured follow-up.

Rejected for now:

- Server-side Korean matching (choseong) for message search: it needs the decomposed text per
  message, i.e. an index. The panel sends the query as a substring.
- Indexing the settings pages' handwritten rows (Memory's algorithm blocks, Image Generation's
  provider blocks, the Model page's slot pickers and response streaming toggle): they are not
  registry items. Their pages are found by page name; a handwritten-row table can follow
  (Decision 12).
- A URL form of the settings deep link: the router writes paths without query or hash
  (`src/ts/router/router.svelte.ts`), so it needs a router change (Decision 11).

## Order

(1, 2a, 4a) → (2b, 2c, 2d, 3a) → 3b → 4b.

- 1, 2a and 4a share no files. 1 can land at any time; 4a needs nothing and runs early so 4b is
  not waiting on the server.
- 2b, 2c, 2d and 3a need 2a's matcher. Their files are disjoint: 2b is `GridCatalog.svelte`,
  `MobileCharacters.svelte`, `SideChatList.svelte` (and `SideChatList.test.ts`); 2c is
  `LoreBookList.svelte`, `LoreBookData.svelte` and a new lorebook test; 2d is
  `ModuleSettings.svelte`, `ModuleChatMenu.svelte`, `PersonaSettings.svelte`; 3a is
  `src/ts/setting/searchIndex.ts` and its test.
- 3b needs 3a. It and 4b both add `src/lang/en.ts` and `src/lang/ko.ts` keys, so they run one after
  the other.
- 4b needs 4a (the route), 2b (`SideChatList.svelte`, `GridCatalog.svelte`: 4b adds the panel's
  entry buttons there) and 3b (`en.ts`, `ko.ts`).

## Slice 1. `color-scheme` on the theme root (_small_, `ui-theming.md`)

- `src/styles.css`: `color-scheme: dark;` in the `:root` block that sets the default
  `--risu-theme-*` palette, so the page before boot and a failed boot match the dark default.
- `src/ts/gui/colorscheme.ts` `updateColorScheme`: after the variables,
  `document.documentElement.style.colorScheme = colorScheme.type === "light" ? "light" : "dark"`
  (a missing or unknown `type` reads as dark, the default scheme's type). Every scheme change
  already goes through it (`changeColorScheme`, `updateCustomColorScheme`, `changeColorSchemeType`
  through `updateCustomColorScheme`, and the boot).
- Do not restyle `<option>` or checkboxes (Decision 1).
- Test: extend `src/ts/gui/guiRecords.test.ts` `updateColorScheme`: after a `dark` scheme
  `document.documentElement.style.colorScheme` is `dark`, after a `light` one `light`, and after a
  scheme with no `type` `dark`. Manual check (record the result in the commit message): on the
  `light` scheme with a dark OS, a native `<select>` popup in Settings › Display opens light; on
  `dark` with a light OS it opens dark.

## Slice 2a. Shared Korean-aware matcher (_small_, `global-api.md`)

- Add `es-hangul` (Decision 2) to `dependencies` with `pnpm add es-hangul@^2.4.0` (`package.json`,
  `pnpm-lock.yaml`). Before adding, re-check that no Hangul library is already in the tree
  (`rg -n "hangul" package.json pnpm-lock.yaml` found none at `c7628a0bb`) and record the version,
  license, that it has no dependencies, and the `pnpm build` chunk size before and after in the
  commit message.
- New `src/ts/util/koreanSearch.ts` (client only; `shared/` needs none of it):
  - `prepareQuery(query: string): PreparedQuery | null`: NFC-normalized, trimmed, lowercased,
    whitespace removed; null for an empty query. Precomputes the query's jamo
    (`disassemble`), whether it is all initial consonants (`canBeChoseong` per character), and the
    QWERTY conversion (`convertQwertyToHangul`) when the query is all Latin letters
    (Decision 3).
  - `matchText(text: string, query: PreparedQuery): number`: 0 for no match, else a score: exact
    (whole text) > prefix > substring > space-insensitive substring > choseong substring (the
    text's `getChoseong` contains an all-choseong query) > jamo substring (the text's
    `disassemble` contains the query's: the half-composed last syllable) > QWERTY-converted
    substring. Case-insensitive for every script.
  - `matchesAny(texts: (string | undefined)[], query: PreparedQuery): boolean` for the lists.
  - Per-text derived forms are computed per call, not cached (the lists are small; a cache keyed by
    text would be a new retention path, see the archived heap memory plan).
- Test: `src/ts/util/koreanSearch.test.ts`: 해적 matches ㅎㅈ, 해저, 해적, 바다해적 and `gowjr`; it
  does not match ㅎㅂ or 해자; English is case- and space-insensitive (`Long Name` matches
  `longna`); the score order above holds for one text per tier; an empty or whitespace query is
  null; a query of a lone jamo (ㅎ) matches by choseong only.

## Slice 2b. Character and chat list filters (_small_, `ui-theming.md` with `characters-modules.md`)

- Depends: 2a.
- `src/lib/Others/GridCatalog.svelte` (owned by `characters-modules.md`) `formatChars` and
  `src/lib/Mobile/MobileCharacters.svelte` (its `normalizeSearch` filter): match the character's
  `name` through `matchesAny`. Keep the existing order and the trash split.
- `src/lib/SideBars/SideChatList.svelte`: a filter field above the list (placeholder
  `language.search`, an existing key), matching each chat's `name` and its folder's name
  (Decision 4). While the field is non-empty: chats that do not match are hidden, a folder with no
  matching chat is hidden, a folder with one is shown open (without writing its stored folded
  state), and every SortableJS instance (`chatsStb`, `folderStb`, including any created while the
  field is non-empty) is disabled (`option("disabled", true)`), so no drag reorders a filtered
  view. Clearing the field restores the list and drag. The field resets when the character changes.
- Test: `src/lib/SideBars/SideChatList.test.ts` (existing; its Sortable mock needs an `option()`
  method): with three chats, two in a folder, a query that matches one foldered chat shows that
  chat and its folder and hides the rest; a choseong query matches a Korean chat name; a folder-name
  query shows the folder's chats; clearing restores every row; the Sortable instances report
  `disabled` while filtered and not after clearing.

## Slice 2c. Lorebook list filter (_hard_, `characters-modules.md`)

- Depends: 2a.
- `src/lib/SideBars/LoreBook/LoreBookList.svelte` renders recursively: a folder entry mounts its
  own `LoreBookList` through `LoreBookData.svelte` (around `LoreBookData.svelte:223`), and folder
  expansion comes from `openedRefs`. So:
  - One root query: the outermost `LoreBookList` (no list above it in Svelte context) renders the
    filter field and provides the prepared query through `setContext`; nested lists read it with
    `getContext` and render no field. Never in the hosts (`LoreBookSetting.svelte`,
    `ModuleMenu.svelte`), and never in `CharConfig.svelte` (a heap-branch file).
  - An entry matches on `comment`, `key` and `secondkey` (Decision 5). A folder is shown when it or
    any entry inside it matches, and is shown expanded while the query is non-empty (without writing
    `openedRefs`'s stored state); inside it only matching entries show, unless the folder's own name
    matched (then all of its entries).
  - Every Sortable creation, including the re-creation after details close (around
    `LoreBookList.svelte:407-412`), is disabled while the query is non-empty, and `expectedElements`
    is not waited on while disabled. Clearing restores the list and drag.
  - The query resets on an owner switch (the list's character, chat or module changes).
- Test: new `src/lib/SideBars/LoreBook/LoreBookList.test.ts` (happy-dom, mounting the root list
  with `externalLoreBooks` and a folder holding entries; mock Sortable as `SideChatList.test.ts`
  does): a key query and a choseong comment query each show only the matching entries; a match
  inside a folder shows the folder expanded with only that entry; a folder-name match shows all its
  entries; the nested list renders no second field; Sortable is disabled while filtered; clearing
  restores every row. This is an integration test of the rendered recursion, not a predicate test.

## Slice 2d. Module and persona filters (_small_, `characters-modules.md`)

- Depends: 2a.
- `src/lib/Setting/Pages/Module/ModuleSettings.svelte`, `ModuleChatMenu.svelte` and
  `src/lib/Setting/Pages/PersonaSettings.svelte` (`linkableModules`): replace
  `toLowerCase().includes` with `matchesAny` over the module `name`.
- Test: extend `src/lib/Setting/Pages/PersonaSettings.test.ts` (existing) with a choseong query
  that finds a Korean module name in the linkable list. The two module lists share the one-line
  change; no test of their own unless one exists.

## Slice 3a. Settings search index and locations (_small_, `settings-i18n.md`)

- Depends: 2a.
- New `src/ts/setting/searchIndex.ts` (pure; no runes, no DOM):
  - `SETTING_LOCATIONS`: built once from the same leaf arrays and sections the pages render, never
    copies (the settings Invariants). Each entry is the item's one canonical destination
    `{ itemId, menu, tab?, sectionId?, opener?, available? }`: `menu` the `SettingsMenuIndex`
    value (`src/ts/settingsMenu.ts` names, or the numbers `SETTINGS_PAGES` in
    `src/ts/router/routes.ts` lists); `tab` the page's tab when it has one (Display's
    `displaySettingsTabs` id; the Prompt preset page's `submenu` 1/2/3); `sectionId` the
    `SettingSection.id` holding it; `opener` the id of a handwritten accordion that must start open
    (`"model.additionalParams"`, `"profile.chatFormat"`); `available(ctx)` the parents' conditions
    the registry does not carry. Sources, re-verified by the verifier (all 174 non-header,
    non-accordion items placed once):
    - Accessibility (11), Interaction (`INTERACTION_SETTINGS_MENU`), Advanced (6), Translation
      (`TRANSLATION_SETTINGS_MENU`): their `*SettingsSections` and `*SettingsHeader`.
    - Display (3): `displaySettingsTabs`, each tab's sections.
    - Model (`MODEL_SETTINGS_MENU`): `modelSettingsSections`, and `modelAdditionalParamsItems` with
      `opener: "model.additionalParams"` (the Additional Params accordion, `ModelSettings.svelte`
      around line 66).
    - Connections (`MODEL_PROFILES_SETTINGS_MENU`): `modelParameterItems`, and
      `chatFormatSettingsItems` with `opener: "profile.chatFormat"` (`ModelProfileEditor.svelte`
      around line 331). Connections is the canonical destination of the chat-format items; the
      Prompt preset page's Ooba block (`OobaSettings.svelte`) renders them too, but is not a
      destination.
    - Prompt preset (`PROMPT_SETTINGS_MENU`): `allBasicParameterItems` (its parameters tab) and
      `promptSettingsSections` (its Others tab).
    - Memory (`MEMORY_SETTINGS_MENU`): `memorySettingsSections`, and `memorySupaMemoryItems` with
      `available` = the SupaMemory branch of the page's `{#if}` chain (`MemorySettings.svelte`
      lines ~172–486): `!hanuraiEnable && !hypav2 && !hypaV3 && supaModelType !== "none"` (the
      chain starts with `hanuraiEnable`, then `hypav2`, then `hypaV3`, then SupaMemory). Transcribe a
      parent's whole `{#if}`/`{:else if}` chain, never only the last branch's own test.
    - Voice (`VOICE_SETTINGS_MENU`): `voiceSettingsItems` (re-check whether the emotion method
      gates them; give `available` if it does). Language (10): `languageSettingsItems`.
    - The implementer audits each handwritten page that renders located items for further parent
      conditions and records each one as an `available` predicate.
  - `searchSettings(query: string, ctx: SettingContext): SettingHit[]`: over every item of
    `getFullSettingsData()` except `header` and `accordion` types, plus one entry per section title,
    per page (the navigation labels `Settings.svelte` shows) and per Model tab (Preset, Connections,
    API Keys, which share one navigation entry). Each item is matched on its label in the current
    language (`getLabel`), its English label (`languageEnglish`), its `keywords`, and its section's
    title, with 2a's `matchText`; a label match outranks a keyword or section match; ties keep
    registry order. Every hit has a non-empty label: an item with no label of its own (for example
    the custom `adv.export`) is labelled by its section title, or left out when it has neither.
    Each hit carries its location and `available: false` when `checkCondition(item, ctx)` or the
    location's `available(ctx)` is false, or when its section would render nothing
    (`sectionHasVisibleItems`) (Decision 9). At most 50 hits.
  - The `ctx` for Connections items is built for the target profile of Decision 16 (the main slot's
    profile, `activeMainProfile`), the same one the jump opens. When the main slot names no existing
    profile (`activeMainProfile.id` undefined: deleting a profile leaves slots dangling), every
    Connections item hit is `available: false` with the reason "the main slot has no connection";
    no other profile is substituted.
  - `getFullSettingsData(searchTerm)` keeps its current behavior (its tests in
    `botSettingsParamsData.test.ts` read it); the new search does not replace it.
  - Read `language` at call time, never at module load (`language` is replaced on a switch).
- Test: `src/ts/setting/searchIndex.test.ts`: every item of `getFullSettingsData()` except
  `header`/`accordion` has exactly one location and every location names a real item (the
  `settingsPageSections.test.ts` pattern); `searchSettings("context", ctx)` includes
  `params.maxContext` with the Connections menu; a Korean query (`changeLanguage("ko")`) matches a
  Korean label and its choseong; an English label still matches under Korean; a label hit ranks above
  a keyword-only hit; an item whose condition fails is `available: false`; `adv.remPunc` is
  `available: false` with HypaV3 on, `false` with Hanurai on (a SupaMemory model set and both Hypa
  flags off), and `true` in the SupaMemory branch's state; a Connections hit is `available: false`
  when the main slot's profile was deleted (another profile remaining); every hit's label is
  non-empty.

## Slice 3b. Settings search UI and deep link (_hard_, `settings-i18n.md`)

- Depends: 3a.
- New `src/ts/setting/settingJump.svelte.ts`: two separate pieces of state. `jumpVersion`, a
  reactive counter that only `openSetting` increments and nothing clears; and the pending jump
  `{ version, itemId, menu, tab, sectionId, opener, profileId, available }`. `openSetting(id)`
  increments `jumpVersion`, records the pending jump with that version, sets `settingsOpen` and
  `SettingsMenuIndex`, and for Display calls `requestDisplayTab(tab)`. `currentJump()` answers the
  pending jump for the page being mounted; `finishJump(version)` clears the pending jump (only when
  it is still that version) once the target page scrolled or showed the unavailable note. Clearing it
  never changes `jumpVersion`, so it never remounts the page it just prepared. `scrollToSetting(itemId)` waits a `tick()`, finds
  `[data-setting-id="<id>"]`, scrolls its first element child with a box into view
  (`block: "center"`) and adds a highlight ring that a timer removes (Decision 10).
- `src/lib/Setting/Settings.svelte`: the page is already wrapped in `{#key $SettingsMenuIndex}`;
  key it by the menu and `jumpVersion` (never by the pending jump), so a jump remounts its page even when it is the page shown
  (a second jump on Display reaches another tab; a closed accordion mounts open). Plus the search
  field at the top of the navigation (`navGroups`): while it is non-empty, the navigation shows the
  hits instead of the groups (label, page › tab › section breadcrumb, and a note for unavailable
  hits). Enter or a click opens the hit (`openSetting`); Escape clears the field. A page or tab hit
  opens the page or tab. Keep the field's text while the settings stay open; clear it when they
  close.
- `src/lib/Setting/SettingRenderer.svelte`: wrap each rendered item in
  `<div class="contents" data-setting-id={item.id}>` (Decision 10).
- `src/lib/Setting/SettingsSections.svelte`: a collapsible section whose id the current jump names
  starts open (`Accordion`'s `startOpen`, read at mount, which the remount makes apply).
- Handwritten accordions named by `opener`: `ModelSettings.svelte` (Additional Params) and
  `Model/ModelProfileEditor.svelte` (Chat Formatting) start open when the current jump names them.
- `src/lib/Setting/Pages/ModelProfilesSettings.svelte`: when the jump carries a `profileId`, select
  that profile (its module-level `selectedId`) before the editor mounts (Decision 16).
- `src/lib/Setting/Pages/PromptPresetSettings.svelte`: at mount, set `submenu` to the jump's tab
  (not in legacy GUI mode, where every tab shows). `DisplaySettings.svelte` already takes
  `requestDisplayTab` at mount.
- Each page that holds located items calls `scrollToSetting` after mount when the jump names one
  of its items and the hit is available, then `finishJump`. An unavailable hit opens the page (and
  tab) and shows a one-line note at the top of the page ("This setting is hidden by another
  setting"), with no section or row promise, then `finishJump`.
- `src/lang/en.ts`: the field's placeholder and label, the empty-result line, the unavailable note;
  `ko.ts` overrides (Decision 14).
- Test: `src/ts/setting/settingJump.test.ts` (fake timers): `openSetting` sets the menu, the jump
  and increments `jumpVersion`; two consecutive `openSetting` calls on the same page give two
  versions; `finishJump` clears only its own version's pending jump and leaves `jumpVersion`
  unchanged; `scrollToSetting` calls `scrollIntoView` on the row's first
  child and removes the ring when the timer runs. A component test for `SettingsSections.svelte`: a
  section the jump names mounts open, another stays closed, and the open section and the row's
  highlight are still present after `finishJump`. If `Settings.svelte` can be mounted in the harness,
  also assert that `finishJump` does not remount the page (a page-local marker survives it). A Playwright check (manual, recorded in
  the commit message; run the dev stack alone, see the playwright memory notes): search `retrys` (the
  English label of `adv.retries`, "Request Retrys when Fail"), open the hit, the Model page shows the Advanced model behavior section
  open with the row highlighted; then, from Display's Theme tab, search a Layout & sizing item and
  open it, the tab switches; then a chat-format item opens Connections on the main profile with
  Chat Formatting open.

## Slice 4a. Server message search route (_hard_, `self-host-server.md`)

- Depends: none.
- New `shared/messageSearch.ts` (types and constants only, relative `.ts` imports, no DOM types):
  `MESSAGE_SEARCH_PATH = "/api/chats/search"` (no existing route under `/api/chats`; the
  `/api/resources/:kind` routes do not collide), `MessageSearchQuery`
  `{ query: string; characterId?: string; chatId?: string; cursor?: string; limit?: number }`,
  `MessageSearchHit` `{ characterId, chatId, messageId, chatName, characterName, role, time?,
snippet: string, matchStart: number, matchLength: number }`, `MessageSearchPage`
  `{ hits, next: string | null, scannedBytes: number }`.
- The scan, in `server/src/data/chatStore.ts` (`createChatTables`) as a batch reader, driven by
  `server/src/data/resourceStore.ts` as `store.searchMessages(query, options)` (the store owns the
  one `DatabaseSync` connection; no second connection):
  - Chats in a stable order: `chats.seq` descending (newest incarnation first; Decision 8),
    restricted to one `characterId`, or one `(characterId, chatId)`, or every character that is
    not trashed (`trashTime` on its `characters` record) and not the playground character
    (`§playground`, an ordinary persisted character created in `PlaygroundMenu.svelte`, whose chats
    are on the server) (Decision 6). A group's chats are stored under the group's own character id
    and are searched like any character's.
  - Per chat, messages by `position` descending, `json_extract(data, '$.data') LIKE ? ESCAPE '\'`
    with `%`, `_` and `\` escaped in the query. Message text only, not translations (Decision 6).
  - Batched: each batch reads at most `batchRows` candidate rows (default 500) by keyset; between
    batches the scan yields to the event loop (an injected `yieldTurn`, `setImmediate` in
    production), so generation streaming, auth and other handlers run between batches. A request
    stops at the first of: `limit` hits (default 30, at most 100), `budgetBytes` scanned (the sum of
    `length(CAST(data AS BLOB))`, the UTF-8 bytes; `length(data)` on TEXT counts characters; default
    64 MiB), or the end; it then returns `next`. A batch also ends after 4 MiB of candidate bytes. The
    budgets are checked after each row, so an oversized single row is scanned whole and the cursor
    always advances by at least one row. All limits are options for tests.
  - Between batches it re-checks the store epoch and the maintenance state: an epoch change ends
    the request with 409 (`{ reason: "epoch" }`; the client restarts the search), maintenance ends it
    as the maintenance gate answers. The request's abort signal (`c.req.raw.signal`, client gone)
    ends it. At most two searches run at once server-wide; a third gets 429.
  - The cursor: opaque base64url JSON `(chatSeq, messageId, position)`, the last scanned message.
    Paging is best effort (Decision 8): positions shift on inserts (`chatStore.ts` around line 771)
    and text checkpoints bump the chat revision on every streamed chunk, so the cursor does not use
    the revision. A continuation looks the anchor up by its key `(chatSeq, messageId)` and continues
    below its current position; only when the anchor is gone does it fall back to the cursor's
    `position`. A cursor whose chat is gone continues with the next lower `seq`. The client still
    drops hits it already shows (by chat ref and message id), and a page whose hits were all dropped
    counts as an empty page for the re-ask rule. A cursor is not tied to an epoch beyond the 409
    above.
  - Snippet: up to 60 characters before and 120 after the first match, cut on the server; the match
    found with the same ASCII-only case folding `LIKE` uses (not `toLowerCase`, which folds more
    than `LIKE` matched). `matchStart`/`matchLength` index into the snippet.
  - Character and chat names: the chat's `meta` name, the character's `name` from its `characters`
    record, read once per distinct character in the page.
- New `server/src/routes/messageSearch.ts` `registerMessageSearchRoutes(app, { store, auth,
limiter, maintenance })`: `POST MESSAGE_SEARCH_PATH` with the authenticated limiter and the
  snapshot maintenance gate (`snapshots.gate`, as `registerResourceRoutes` takes),
  `Cache-Control: no-store`. Registration in `server/src/app.ts` also adds the path to the
  own-body-limit list (around `app.ts:457`; the route caps its body at 4 KiB on the actual bytes) and
  to the resource admission tracking (the path test around `app.ts:405`, `snapshots.track`), so
  shutdown waits for a running search. Maintenance does not wait for it (it waits for storage-gate
  admissions only): the route takes the maintenance gate at admission, and a running search sees
  maintenance or the new epoch at its next between-batch check and ends. 400 for a query shorter than 2 characters after NFC trim
  (Decision 13) or longer than 200, an unknown field, a bad cursor, or an invalid id; 404 for a named
  character or chat that does not exist.
- Test: `server/src/tests/messageSearch.test.ts` (Node, in-process `createServerContext`): a
  Korean and an English hit with snippets and offsets; ASCII case-insensitivity; `%` and `_` in the
  query match literally; scope by character and by chat; a trashed character's and the playground's
  chats are skipped in the all-characters scope and a trashed character is searched when named;
  paging with `limit: 1` returns every hit once in order across pages; a small `budgetBytes`
  returns `next` with fewer hits than `limit`; an insert before the anchor and a text checkpoint in the
  cursor's chat between two pages neither repeat nor lose a hit; with an injected `yieldTurn` latch, a second request's handler
  runs while the first is between batches; an epoch change between batches answers 409; a third
  concurrent search answers 429; 400s and 404s above; unauthenticated 401; the maintenance gate
  answers as for resource routes; the response has `Cache-Control: no-store`.

## Slice 4b. Message search panel and jump to message (_hard_, `ui-theming.md` with `app-shell.md`)

- Depends: 4a, 2b, 3b.
- New `src/ts/messageSearch.svelte.ts`: `searchMessages(query, scope, cursor)` over `authFetch`
  (`src/ts/storage/serverAuth.ts`, imported, not edited); the panel's open state and scope
  (`{ kind: "all" } | { kind: "character", chaId } | { kind: "chat", ref }`); and the jump
  `{ token, ref: ChatRef, messageId, state: "pending" | "claimed" }` with a token-checked lifecycle:
  `requestMessageJump(ref, messageId)` (a new token; it replaces any older jump, pending or
  claimed), `claimMessageJump(ref)` (returns the pending jump for that ref once and marks it claimed;
  a claimed or absent jump returns null), `completeMessageJump(token)` and
  `cancelMessageJump(token)` (both remove it when the token is current). Any change of the selected
  chat (`currentChatRef()`) to a ref other than the jump's cancels it, pending or claimed, so going
  away and back never runs it again.
- New `src/lib/Others/MessageSearch.svelte`: a modal mounted once in `src/App.svelte` (owned by
  `app-shell.md`; next to `BookmarkList` and `HypaV3Modal`) with the query field, a scope switch
  (this chat / this character / all characters), result rows (character, chat name, role, relative
  time, snippet with the match in a `<mark>`, built from text nodes; never `{@html}`, S1), and
  "Load more" while `next` is set. A query runs after typing stops (300 ms debounce) or on Enter; a
  newer query cancels the older request (`AbortController`) and ignores its answer (a request
  token). While a page came back without hits and `next` is set, the panel asks again
  automatically up to 5 times before showing "Load more" (Decision 8). A 409 restarts the search
  once. Hits already shown (same chat ref and message id) are dropped from later pages.
- Opening a hit: close the panel, clear the catalog screen (`gridOpenStore.set(false)`: `App.svelte`
  renders the catalog instead of `ChatScreen` while it is true, and `openPinnedChat` does not clear
  it), then `openPinnedChat(ref)` (`src/ts/globalApi.svelte.ts`, imported) and
  `requestMessageJump(ref, messageId)`.
- `src/lib/ChatScreens/DefaultChatScreen.svelte`: an effect that, once the selected chat
  (`currentChatRef()`) is the jump's ref and loaded (`selectedChatLoad()` null), claims it
  (`claimMessageJump`, before any await, as the bookmark effect consumes `ScrollToMessageStore`
  first) and runs `scrollToMessageId(jump)` beside the existing `scrollToMessage(index)`; at its
  end it calls `completeMessageJump(token)`, or `cancelMessageJump(token)` when it stopped:
  - It owns the jump by token and stops at any await after which the token is no longer current or
    `currentChatRef()` is no longer the jump's ref (another chat selected, another hit opened).
  - It finds the index by `Message.chatId` in the selected chat after every await (D1); a message
    id can occur in several chats (copies keep message ids), so it never searches outside the ref.
  - When a fold hides the target (`chatFoldedStateMessageIndex.index` is set and below the target's
    index; `Chats.svelte` starts its window at the fold), it clears the fold as the chat screen's
    show-all button does (`chatFoldedState.data = null`).
  - It sets `isScrollingToMessage`, grows `loadPages` to reach the target, awaits
    `chatsInstance.whenRendered()` (the rows' deferred mount and reveal), then looks the row up again
    (`[data-chat-index]` for the freshly found index), checks it is still connected, scrolls and
    rings it as `scrollToMessage` does.
  - A message that is gone shows `alertNormal` (U3).
  - `ScrollToMessageStore` and the bookmark jump stay as they are (`stores.svelte.ts` is a heap
    file).
- Entry points: the sidebar chat list toolbar (`SideChatList.svelte`, scope this character) and the
  character catalog header (`GridCatalog.svelte`, scope all characters); Decision 15.
- `src/lang/en.ts` strings (title, placeholder, scopes, empty, load more, message gone, error) and
  `ko.ts` overrides (Decision 14).
- Test: `src/ts/messageSearch.test.ts`: the request body for each scope, cursor passing, an error
  answer surfaces as an error state; a newer `requestMessageJump` replaces the older token; `claimMessageJump` answers once (a second
  claim, or a claim for another ref, is null); `completeMessageJump`/`cancelMessageJump` with a stale
  token change nothing; a selection change to another chat cancels a pending and a claimed jump, and
  selecting the jump's chat again afterwards claims nothing (exactly once, checked with a latch, no
  timers). A
  component test for `MessageSearch.svelte` with a mocked `searchMessages` (fake timers): debounce,
  stale answers ignored, "Load more" appends and drops repeated hits, the empty-page re-ask stops at
  5, the snippet renders `<mark>` and no HTML from the text (a snippet containing `<img onerror>`
  renders as text), opening a hit clears `gridOpenStore` and calls `openPinnedChat` (mocked) with the
  ref. A test of `scrollToMessageId`'s decision logic, extracted as a pure helper beside
  `DefaultChatScreen.svelte` if the component cannot be mounted (the index found by id within the
  ref, a token change or a ref change stops it, a fold before the target is cleared). A Playwright
  check (manual, recorded): from the catalog, search a word from an old message of another
  character, open the hit, the chat opens scrolled to the message with the ring; repeat on a chat
  with a fold set before the message.

## Decisions

Each entry lists the options and the default the runner takes without asking. The user may
override any of them before or between slices.

1. **Native control styling beyond `color-scheme`** (slice 1). (a) `color-scheme` only;
   (b) also style `<option>` and checked checkboxes with theme tokens, as Haejeok `6017ae077` and
   `323d16328` do. Default (a): `color-scheme` fixes the popups' scheme; restyling options is a
   separate visual change.
2. **Korean matching library** (slice 2a). (a) `es-hangul@^2.4.0` (Toss; ESM, tree-shakable, no
   dependencies per Haejeok's lockfile snapshot `es-hangul@2.4.0: {}`); (b) a hand-written helper
   (choseong and jamo by Unicode arithmetic, ~40 lines; no QWERTY or romanization); (c) another
   library. Nothing Hangul-related is in metatron's `package.json` or `pnpm-lock.yaml` at
   `c7628a0bb`. Default (a): it covers choseong, jamo, QWERTY conversion and romanization with
   tested tables; re-verify the license (MIT expected) and the bundle growth at install and fall
   back to (b) if either surprises.
3. **Matcher tiers** (slice 2a). Substring, space-insensitive, choseong and jamo are always on.
   QWERTY→Hangul conversion: (a) on for all-Latin queries, ranked last; (b) off. Romanization
   (`haejeok` → 해적): (a) off; (b) on. Default: QWERTY on, romanization off (romanized queries
   match too many English names).
4. **Chat list filter fields** (slice 2b). (a) chat name only; (b) also the folder name (a folder
   whose name matches shows all its chats). Default (b).
5. **Lorebook filter fields** (slice 2c). (a) `comment`, `key`, `secondkey` (and a folder's own
   name); (b) also `content`. Default (a): content matches flood the list.
6. **Message search coverage** (slice 4a). Translations (`Message.translation.text`): (a) not
   searched; (b) searched as a second field. Trashed characters in the all-characters scope:
   (a) skipped; (b) included and marked. Playground chats (`§playground`): (a) skipped;
   (b) included. Default: (a) for all three; a character or chat named in the scope is searched even
   when trashed.
7. **Message search index** (slice 4a). (a) batched `LIKE` scan over `json_extract(data,'$.data')`,
   no index; (b) an FTS5 `trigram` table in a separate derived file (`save/data/search.sqlite`,
   outside snapshots and archives like `vectors.sqlite`), refreshed lazily per chat by
   `(chats.seq, revision)` stamps, with `LIKE` for queries under 3 characters; (c) FTS5 in the
   resource database maintained by triggers (grows every backup by ~2.5x the message text; restore
   and `VACUUM` renumber the implicit rowids it would key on). Default (a), per the measurement under
   Approach; revisit (b) if a real database's full scan exceeds ~1 s.
8. **Message search order and paging** (slices 4a, 4b). (a) chats by `seq` descending, messages
   newest first, a best-effort cursor anchored on the last scanned message id
   `(chatSeq, messageId, position)`, client-side dedupe, a per-request byte budget; (b) chats by
   `lastDate` (recently used first), which moves between pages and can skip a chat; (c) a
   snapshot-consistent search (one read transaction for the whole search), which blocks writes'
   checkpointing and needs the scan unbatched. Default (a), with the client re-asking up to 5 times
   on an empty page.
9. **Settings hits that are unavailable** (slices 3a, 3b): an item whose own or parents' condition
   fails, or whose section renders nothing. (a) listed with a note; opening one opens its page and
   tab with a one-line "hidden by another setting" note, no row or section highlight; (b) left out.
   Default (a): the user learns the setting exists and where.
10. **Settings row anchor** (slice 3b). (a) a `display: contents` wrapper with `data-setting-id`
    in `SettingRenderer`, scrolling its first child with a box; (b) the attribute on each of the 12
    wrapper components' root elements. Default (a): one place, no layout change. The highlight is a
    2 s `ring-2` like `scrollToMessage`'s.
11. **URL deep links for settings** (slice 3b). (a) in-app only (`openSetting(id)`); (b) also
    `/settings/<page>#<item-id>` through the router. Default (a): the router drops hashes today;
    (b) can follow.
12. **Settings search coverage** (slice 3a). (a) registry items, section titles, page and Model tab
    names; (b) also a hand-maintained table of handwritten rows (Memory, Image Generation, Model slot
    pickers and response streaming, API keys); (c) also help texts (`helpKey`). Default (a).
13. **Minimum message query length** (slice 4a). (a) 2 characters after NFC trim; (b) 1. Default
    (a): a single syllable or letter matches most messages and costs a full scan per page.
14. **Locales for new strings** (slices 3b, 4b). (a) `en.ts` plus `ko.ts`; (b) every locale;
    (c) `en.ts` only. Default (a): the feature targets Korean users; other locales fall back to
    English through `changeLanguage`.
15. **Message search entry points** (slice 4b). (a) the sidebar chat list toolbar (this
    character) and the character catalog (all characters); (b) also a hotkey (`defaulthotkeys.ts`,
    app-shell); (c) also the chat screen's menu (this chat). Default (a); the scope switch in the
    panel reaches "this chat".
16. **Target profile of a Connections hit** (slices 3a, 3b). Connections keeps its own selected
    profile (`ModelProfilesSettings.svelte` module-level `selectedId`, falling back to the first
    profile), while the registry's default context uses the main slot's profile. (a) the main slot's
    profile (`activeMainProfile`): availability is computed for it and the jump selects it;
    (b) the profile Connections last showed. Default (a): the profile the chat actually uses. When
    the main slot names no existing profile, the hit is unavailable ("the main slot has no
    connection"; the jump opens Connections without selecting or highlighting anything), never
    redirected to another profile.
17. **Concurrent message searches** (slice 4a). (a) at most two server-wide, a third gets 429;
    (b) one per client token; (c) unlimited. Default (a): one user, two tabs.

## Open Questions

- Message search on a real large database: the measurement is synthetic (low-entropy text, 175 MB).
  Slice 4b's manual check should log one full search's time on the largest available database; if
  it is above ~1 s, propose Decision 7 (b) as its own plan.
- `es-hangul`'s bundle cost after tree-shaking is unmeasured; slice 2a records it.
- Whether the Voice page's emotion method gates `voiceSettingsItems` (slice 3a's `available`) was
  not checked; slice 3a reads `VoiceSettings.svelte` before placing them.
- `prose-invert={$ColorSchemeTypeStore}` in `AlertComp.svelte` and `MultiLangDisplay.svelte` is
  always truthy (`"dark"` and `"light"` are both non-empty): a separate small fix, not in this plan.
- The persona list itself (survey F7) gets no name filter here; only its linkable-module filter
  changes (2d).
