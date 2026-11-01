# Settings UI, Bot Presets, Prompt Template Editor, i18n

## Scope

- Owns:
  - the declarative settings registry and its wrappers,
  - settings navigation and pages,
  - the Model and Prompt pages and their preset lists (model and prompt presets), switching, import, and export,
  - the prompt template editor and prompt diff,
  - language files and switching.
- Paths:
  - `src/ts/setting/*`, `src/ts/settingsMenu.ts`
  - `src/lib/Setting/**`, except `Pages/Module/` (the module catalog, its share button's export and alert handling, and
    the editor: [characters-modules](characters-modules.md)), `PersonaSettings.svelte`, `listedPersona.svelte`,
    `Advanced/SettingsExportButtons.svelte`, `Advanced/CustomModelsSettings.svelte`, `ApiKeysSettings.svelte`
    (`llm-requests.md`), `PluginSettings.svelte`, `Pages/Translation/TranslatorPresetSettings.svelte`,
    `Pages/Model/AuxModelSelectors.svelte` (the last two belong to [media-aux](media-aux.md))
  - `src/lang/*`
  - `src/lib/UI/PromptDataItem.svelte`
  - `src/lib/Others/PromptDiffModal.svelte`
- Not here:
  - DB defaults and migration rules → `persistence.md`.
  - The prompt item runtime → `chat-pipeline.md`.
  - Translator presets → `media-aux.md`.

## Files

### Registry and helpers

These live in `src/ts/setting/`.

- `types.ts`:
  - `SettingItem`: `id`, `type`, `bindKey` | `bindPath` (dotted) | `getValue(ctx)`/`setValue(value, ctx)`,
    `condition(ctx)`, `onChange`, `options`, `labelKey`/`fallbackLabel`, `componentId`/`componentProps`. `bindKey` is a
    `SettingsRootKey` (a root name the settings views serve; `pnpm check` refuses any other), and so is `bindPath`'s
    first segment.
  - `SettingContext`: `{settings, preset, modelPreset, modelProfile, persona, modelInfo, subModelInfo}`: the settings
    views, the selected preset (`activePreset`, by its own field names), and the selected persona (`activePersona`),
    from `src/ts/storage/settingsViews.svelte.ts`.
  - `SettingSection`: a named group on a sectioned page; its id is independent of item ids.
  - `SettingCategory`: unused.
- `sections.ts` `itemsById(source, ids)`: the items of a leaf array by id, in the order asked, the same objects; throws
  on an unknown or repeated id. Apart from `utils.ts`, which imports the data arrays that call it.
- `settingRegistry.ts` `settingRegistry`: maps each `SettingType` to a wrapper component.
- `utils.ts`: `getSettingValue`, `setSettingValue` (a `bindKey`, or `bindPath`'s first segment, read and written through
  `readSettingsRoot`/`writeSettingsRoot`), `checkCondition`, `getLabel`, `settingContext` (the context both renderers
  build), `sectionHasVisibleItems`, and `updateSettingValue` (the wrappers' write: skips an unchanged value, so
  `onChange` fires once per edit).
- `utils.ts` `getFullSettingsData`: the catalog, every page's leaf arrays, the Language and Translation ones included.
  Its own label and keyword filter has no UI; `searchIndex.ts` searches over it.
- `customComponents.ts` `customComponents`: maps component IDs to components for `type:'custom'`.

### Settings search and jumps

These live in `src/ts/setting/`.

- An item in a page's leaf array and its section's `itemsById` list is indexed with no further edit, since
  `searchIndex.ts` reads the same sections (`## Recipes`, "Add a setting to a sectioned page"). A new leaf array or page
  also needs its `placeItems`/`placeSections` call; `searchIndex.test.ts` fails on a catalog item with no location.
- `searchIndex.ts` (pure) `SETTING_LOCATIONS` (and `settingLocation(id)`): every catalog item but `header`/`accordion`
  placed once, read from the header arrays, sections, and leaf arrays the pages render. A location names the menu
  (`SettingsMenuIndex`), the tab (Display's tab id, the Prompt page's `submenu` 1 or 3), and the `sectionId`.
- A location's `opener` is the handwritten accordion that must start open: `model.additionalParams` or
  `profile.chatFormat`. Connections is the chat-format items' destination, not the Prompt page's Ooba block.
- An item needs an `opener` only when it renders inside a handwritten accordion; a `collapsible` section opens for its
  jump by itself. To add one, extend `SettingOpener`, pass it in the item's `placeItems` call, and have the page read
  `currentJump()` at mount and pass `startOpen` while `jump.available` (`ModelSettings.svelte` `openAdditionalParams`).
- A location's `available(ctx)` is a parent condition the registry lacks. Only `adv.remPunc` has one:
  `MemorySettings.svelte`'s whole Hanurai/HypaV2/HypaV3/SupaMemory chain. The Voice page's emotion method gates nothing.
- `searchSettings(query, ctx)` ranks, with `koreanSearch.ts` `matchText`, the navigation pages and the three Model tabs
  (labels listed beside `Settings.svelte`'s `navGroups` and `ModelMenuTabs`), the section titles, and the items by label
  (current language and English), keywords and section title. Any label match outranks a keyword or section match, equal
  scores keep that order, and it returns at most `SETTING_HIT_LIMIT` (50).
- A `SettingHit` has a non-empty label (an unlabelled item takes its section title), a breadcrumb, its `target`, and
  `available: false` with a `reason` (`hidden`: its own, a parent's, or its section's condition fails; `noMainProfile`:
  a Connections item while the main slot names no profile). A Connections item is checked against `activeMainProfile`
  and carries its `profileId`.
- `settingJump.svelte.ts` `openSetting(hit)` (the in-app deep link; no URL form) takes a `SettingHit`, since section and
  page hits have no item location and the hit's `available` and `profileId` are `searchSettings`'. It increments
  `jumpVersion()` (reactive; only `openSetting` changes it), records the pending jump with that version, calls
  `requestDisplayTab` for a Display tab, and opens the settings on the hit's menu.
- `settingJump.svelte.ts` `currentJump()` answers the pending jump while its menu is exactly `SettingsMenuIndex` (not
  reactive; the mount-time consumers read it once). `finishJump(version)` clears it only when it is still that version
  and never changes `jumpVersion()`, so it never remounts the page it prepared.
- `settingJump.svelte.ts` `scrollToSetting` and `scrollToSection` wait a tick, check `isCurrent`, and scroll into view
  with a ring that `SETTING_HIGHLIGHT_MS` (2 s) removes: a row's first element child with a box (none with a box:
  nothing), or a section hit's `[data-settings-section]` wrapper.

### Data arrays

These live in `src/ts/setting/`.

- An item's id prefix names the page it came from, not the page it sits on: search the id before assuming its page
  (`acc.`, `adv.`, and `display.` ids sit on several pages).
- Page data lives in `accessibilitySettingsData.ts`, `interactionSettingsData.ts`, `advancedSettingsData.ts`,
  `translationSettingsData.ts`, `botSettingsParamsData.ts`, `chatFormatSettingsData.ts`,
  `displaySettingsData.svelte.ts`, `languageSettingsData.svelte.ts`, `modelSettingsData.ts`, `promptSettingsData.ts`,
  `memorySettingsData.ts`, and `voiceSettingsData.ts`.
- Display owns its tab and section order. Model and Prompt data split registry items from controls rendered in
  handwritten tabs.
- Keep each item in one leaf array and place it by id with `itemsById`; `settingsPageSections.test.ts` and
  `searchIndex.test.ts` check placement and search coverage (see [Recipes](#recipes)).
- Put a conditional item with the field that controls it. Translation's `translator` and `translatorType` gate most of
  that page; see its section data for the exceptions.
- The Language page's `translang` option downloads a locale for translators; it is not a UI locale. Locale files, picker
  options, and browser first-boot matching are separate; see [Languages](#languages).

### Renderers and credential links

These live in `src/lib/Setting/`.

- `SettingRenderer.svelte`: derives the context (`settingContext`: the views and the selected preset's
  `aiModel`/`subModel` model info), filters by `checkCondition`, and renders `settingRegistry[item.type]` keyed by
  `item.id`, each inside a `<div class="contents" data-setting-id={item.id}>` (the search jump's anchor, no box of its
  own).
- `SettingsSections.svelte` (`sections: SettingSection[]`): per section, a `<section>` with `SettingRenderer`; a
  `collapsible` one is a closed `styled` `UI/Accordion`. Each wrapper carries `data-settings-section={id}`. A section
  whose items all fail their conditions (`sectionHasVisibleItems`, over the same context) renders nothing. A collapsible
  section that an available search jump names (`currentJump()`, read at mount) starts open.
- `Wrappers/Setting*.svelte`: a function binding
  (`bind:value={() => getSettingValue(...), (v) => updateSettingValue(...)}`), so an edit is written synchronously, into
  the preset selected at that moment. No local copy and no write-back effect. `SettingSegmented` binds the same way.
- `src/ts/setting/credentialLinks.ts` `CREDENTIAL_OWNERS` (a shared credential has one editing place): `openAIKey` and
  `google` belong to the API Keys tab, `NAIApiKey` to Image Generation's NovelAI block, `supaMemoryKey` to Memory.
- `CredentialStatusLink.svelte`: elsewhere, the status `SecretInput` shows (or `maskedLeaf` of the plain
  `secrets.NAIApiKey`) and an "Edit in …" button. The links are on Voice & Emotion (OpenAI, NovelAI), Image Generation
  (DALL-E's OpenAI, Imagen's Google) and the Playground embedding tool (`supaMemoryKey`).
- `credentialLinks.ts` `openCredentialOwner` opens the settings at the owner and leaves a one-shot request,
  `takeCredentialRequest`, which the owner reads once at mount. It then shows the field even where its condition would
  hide it, and `scrollToCredential` scrolls to the field's `data-credential` wrapper and focuses its first input.

### Settings navigation

- `Settings.svelte` `navGroups`: the sidebar, in groups (Chat setup, Features, Interface, Data, Advanced & about), then
  the plugin-added menus. An entry is highlighted on any of its menu indexes.
- `SettingsMenuIndex` selects the page. The named values live in `src/ts/settingsMenu.ts`, re-exported by
  `src/ts/stores.svelte.ts`, and the URL slugs in `src/ts/router/routes.ts` (`/settings/bot` is an alias of
  `/settings/memory`). The other pages go by number, such as 13, the prompt template editor.
- The Model menu is one sidebar entry over three indexes (Preset, and Connections and API Keys, both in
  `llm-requests.md`): `Pages/Model/ModelMenuTabs.svelte`, the heading and the tab bar each of the three pages renders,
  switches between them by setting the index.
- `Settings.svelte` keys the page by the menu and `jumpVersion()`, so a search jump remounts its page even when it is
  the page shown.
- The settings search is a field at the top of the navigation (`language.settingsSearch`): while its query is non-empty
  the navigation lists `searchSettings` hits (label, breadcrumb, a line for an unavailable hit) instead of the groups.
  Enter opens the first hit (not during an IME composition), a click opens that hit, and Escape clears the field. The
  query lives in the component, so it survives a phone's page round trip and is gone when the settings close.
- An attachment on the keyed page runs the jump after each mount: an available item or section hit is scrolled to and
  ringed within that page, an unavailable one shows a one-line note at the top of the page (`hiddenNote`, or
  `noMainProfileNote`) with no section or row opened; then `finishJump`.

### Declarative pages

Pages live in `src/lib/Setting/Pages/`.

- `AccessibilitySettings`, `InteractionSettings`, `AdvancedSettings`, and `TranslationSettings` are sectioned: the
  page's header array, then `SettingsSections` over its sections. `AccessibilitySettings` then adds a handwritten link
  button that opens Display, 3, on its Layout & sizing tab through `requestDisplayTab`.
- `DisplaySettings` is sectioned per tab: a handwritten heading and tab bar, then `SettingsSections` over the selected
  tab's sections. It opens on Theme, or once on the tab another page asked for with `requestDisplayTab`
  (`displaySettingsData.svelte.ts`, read by `takeRequestedDisplayTab` at mount). With `settings.ui.useLegacyGUI`, read
  at mount, it has no tab bar and stacks every tab's sections in tab order (`displaySettingsSections`).
- `ChatFormatSettings` and `LanguageSettings` (the UI language only).

### Model and Prompt pages

These are hybrids of handwritten controls and registry items.

- `ModelSettings`: the model preset: the main and sub slot pickers (`Model/ProfileSlotSelect`), the aux models
  (`Model/AuxModelSelectors`), the Vertex region, the global request toggles such as response streaming, and additional
  parameters.
- `ModelProfilesSettings`: the model profiles, shown as Connections, `MODEL_PROFILES_SETTINGS_MENU`. The selected
  profile is module state, so it survives a tab switch's remount (the first profile when it is gone), and a search jump
  with a `profileId` selects that profile at mount.
- `Model/ModelProfileEditor` edits the selected profile by id: model, `CredentialSelect`, and the model's blocks:
  reverse proxy, OpenRouter (`OpenrouterSettings`), local URLs, Ollama and NanoGPT, chat format, system replacement,
  custom flags, tools, `maxContext`, image output ([model profiles and slots](llm-requests.md)).
- `PromptPresetSettings`: the prompt preset. Its parameters tab renders `allBasicParameterItems`, and its prompt and
  others tabs are handwritten. It opens on a search jump's tab, except in the legacy GUI.
- The handwritten accordions a location names as `opener` (Model's Additional Params, `Model/ModelProfileEditor`'s Chat
  Formatting) start open for an available jump.

### Memory page

- `MemorySettings` is a handwritten page for memory providers, presets, and the embedding model, with registered items
  from `memorySettingsData.ts`. It owns the `supaMemoryKey` input and HypaV3 budget controls.
- `structuredMemory` selects by `ui.memoryAlgorithmType`, read ahead of the flags it clears. Its branch shares the
  preset picker, budget mode, and memory maximum as snippets ([writer settings](structured-memory-writer.md#state)).
- Summarization, budget, and task behavior belong to [memory](memory.md). The prompt-preset max-context override read by
  this page is in [State](#state).

### Other handwritten pages

- Image Generation settings own provider controls and `NAIApiKey`; provider behavior belongs to [media](media-aux.md).
  Its WaveSpeed LoRA rows are an editing copy: only an edit or unsupported-model reset saves them. Unsaved rows survive
  a remote `secrets` revision change and show a conflict warning until the next edit. Voice settings show TTS and
  Emotion Images controls; runtime behavior is in [media](media-aux.md).
- Other handwritten pages include `PromptSettings`, `OobaSettings`, `OpenrouterSettings`, `UserSettings`, `ThanksPage`,
  and `Display/*`.
- `Pages/HotkeySettings.svelte`: menu index 15 renders this page at every width; below 768 px it shows
  `language.screenTooSmall` instead of the table. The table lists `activeHotkeys` (`hotkey.ts`), which hides
  `quickSettings`: Ctrl+Q only shows `language.quickSettingsRemoved` ([app-shell](app-shell.md)).

### Preset lists

`botpreset.svelte` and `BindingScopeNote.svelte` live in `src/lib/Setting/`.

- A pick uses `pickBinding` (`src/ts/storage/chatBindingPick.ts`): it binds the open chat, or changes the tab selection
  at home ([chat bindings](persistence.md)). A picker opened for one chat carries `{ chatRef }` and closes if that chat
  disappears. Ctrl+1..9 and persona pickers use the same path.
- The prompt list supports pick, reorder, copy, add, rename, delete, import/export, diff, archive, and Ctrl+1..9. The
  model list supports pick, reorder, copy, add, rename, and delete (never the last preset).
- Prompt presets have active and archived views. Archiving changes list metadata only; archived entries remain
  selectable, while numbering counts active entries. Archiving leaves selection and chat bindings alone; the archived
  view hides add/import and numbering. Drag/drop and diff actions carry ids, then resolve the current position; drops
  insert relative to shown rows.
- `App.svelte` mounts one list per store. `BindingScopeNote.svelte` marks the setting as chat-bound or unset while a
  chat is open, and is hidden at home.
- `src/ts/storage/presets.svelte.ts` `importPreset` returns the new id after success, or no value if the picker is
  cancelled. The share receiver consumes its cached preset only after success.

### Prompt and parameter editors

- `UI/PromptDataItem.svelte`: edits one `PromptItem`.
- `Others/PromptDiffModal.svelte`: diffs the prompt templates of saved presets. Preferences are stored in
  `db.promptDiffPrefs`.

### Languages

These live in `src/lang/`.

- `index.ts`: `language` (a mutable export) and `changeLanguage(code)`, which merges the locale over a clone of English.
- `en.ts` `languageEnglish`: the source of truth and the type.
- `de`, `es`, `ko`, `vi`, `cn`, `zh-Hant`: `DeepPartial` overrides.
- Manual selection needs the locale file, a `changeLanguage` branch, and the picker option. `BROWSER_UI_LANGUAGES` only
  affects first-boot matching of the browser's base code (`## Recipes`).
- `serverAuth` supplies the self-host authentication failure fallbacks as functions taking the HTTP status, with Korean
  overrides and English fallback for other locales. Server-provided error text takes precedence.
- `help.keepSessionAlive` describes the continuously looping inaudible 20 Hz tone used by Via Sound, Android's media
  notification, and possible interruption of other music apps, in English and Korean ([app shell](app-shell.md)).

## Flows

- Boot installs records before `changeLanguage(settings.ui.language)`. A registry edit goes through its wrapper and the
  settings view to the owning record, which queues the save.
- Search runs `searchSettings` → `openSetting` → keyed page mount → `currentJump()` → scroll/highlight or unavailable
  note → `finishJump`; see [Settings search and jumps](#settings-search-and-jumps).
- Preset switching changes the selected record; picking uses `pickBinding` and may update an open chat's binding. The
  field and chat-binding rules are in [persistence](persistence.md#settings-records).
- The Language `onChange` handles the `translang` export first (then restores UI language to English), calls
  `changeLanguage`, and sets `langState.changed` for the restart warning.
- Prompt image edits capture the preset id before opening the dialog and apply only if that record still exists.
- SillyTavern import computes `PresensePenalty` from `presence_penalty`; a missing value becomes `NaN`, then
  `normalizePreset` replaces it with the `PRESET_DEFAULTS` value.

## State

- Persisted settings belong to resource records ([persistence](persistence.md)); pages and registry wrappers use
  `src/ts/storage/settingsViews.svelte.ts` rather than a whole-database object. `settings.*` accesses section records
  and collections; `activePreset.*`, `activeModelPreset.*`, and `activePersona.*` expose the selected record's own
  fields. Other tab readers and writers use these same views.
- When a chat is open, active prompt/model/persona views follow its bound record when present, then the tab selection.
  Missing preset fields read as fresh defaults, so editing the returned copy does not save; writes resolve the current
  record, so async handlers capture its id before awaiting. See [selection rules](persistence.md#settings-records).
- `maxContextOverride` / `maxContextOverrideSize` (zero means unset) replace the main profile's `maxContext` for the
  server request and tab CBS roots; plugin roots and the settings root still expose the profile value.
- `language` is replaced on switch; a component that captures it at module initialization keeps stale strings.
- UI stores used here: `settingsOpen`, `SettingsMenuIndex`, `openPresetList`, and `openModelPresetList` (`true` or
  `{ chatRef }` for a picker bound to one chat).

## Coupling

- Depends on `database.svelte.ts` (types, presets), `getModelInfo`/`LLMFlags`, platform flags, GUI helpers, the
  translator, and prompt tokenization.

## Invariants

- A new setting needs: a `Database` field, its place and default (`persistence.md`, "Add a persisted setting"), a
  `SettingItem` in the right data array (or handwritten UI), and an `en.ts` key.
- Keep `item.id` values unique and stable. An item keeps its id when it moves to another section or page; section ids
  are separate and unique across pages.
- A moved item's definition moves to its new page's data file (its leaf array), keeping its id, and leaves its old leaf
  array, so it disappears from its old page by itself.
- A page's sections are built with `itemsById` from its leaf arrays, never from copies; the leaf arrays stay in
  `getFullSettingsData`, which lists each item once.
- A section is collapsible only for developer, experimental, and legacy (or similarly rare) groups; ordinary sections
  stay visible. A custom component with its own accordion (`BanCharacterSetSettings`, `CustomModelsSettings`) takes
  `componentProps: { noAccordion: true }` when it sits in a collapsible section. A conditional item stays in the section
  of the item its condition reads; a page-wide gate is exempt (the Translation page's `translator`/`translatorType`,
  which most of its items read: Behavior and Cache sit in their own sections and hide with it).
- Value precedence: `getValue`, then `bindPath`, then `bindKey`. `setSettingValue` creates missing path objects.
- `SettingSelect`/`SettingSegmented` reset a value whose option becomes hidden. Both read and write that value
  untracked, so a preset switch that leaves the options as they are does not reset it: a preset holding a hidden option
  (for example `thinkingType: "adaptive"` under a budget-only Claude model) keeps it. Both track only the visible option
  values (`JSON.stringify`), so a context rebuilt with the same options (a fresh model info after a chat's prompt
  binding changes) does not run the reset.
- `SettingSelect` keeps its last-visible-option fallback. `SettingSegmented` takes the same value sources as the other
  wrappers.
- A preset-owned field must be added to `botPreset` and `PRESET_DEFAULTS` in `shared/presets.ts` (the canonical list
  `normalizePreset` uses; a field of how a model is reached or what it accepts goes to `MODEL_PROFILE_FIELDS` and the
  `ModelProfile` type instead, a slot choice to `MODEL_PRESET_FIELDS` and the `ModelPreset` type), edited on its owner's
  page (`ModelProfilesSettings`, `ModelSettings`, or `PromptPresetSettings`), and never be a secret.
- Credentials belong in the `llmSecrets` section (a named key in its `credentials` map, bound by a profile's
  `credentialId`), and `downloadPreset` blanks the endpoint fields.
- A credential field is edited with `src/lib/UI/GUI/SecretInput.svelte` (`path` a `shared/llmSecrets.ts` `SecretPath`):
  it shows the stored key's status (set with its last four characters, not set, saving), replaces it on Enter or the
  button (once; the field empties), and clears it; the draft is dropped when the path changes.
- Never `bind:` an LLM credential field (an `llmSecrets` credential): it reads `""`. The auxiliary credentials of the
  `secrets` section are ordinary readable fields, bound like any other (`settings.secrets.<field>`).
- A profile field is bound through `profileForSlot({ profileId })` (or `activeMainProfile`), never through its root
  name, so editing a profile that is not in the main slot works.
- A setting textarea tied to a selected record passes its id as `popupEditorContext`; popup write-back rules belong to
  [UI](ui-theming.md#gui-primitives).
- Preserve misspelled keys: `PresensePenalty`, `seperateParameters`, `seperateModels`, `JinjaTemplate`.
- `seperateParametersEnabled` and `seperateParameters` stay in the preset and `providers` shape for saved data and
  preset files; no current UI or request behavior consumes them. Preserve their imported/normalized shape.
- Prompt edits must keep the `PromptItem` discriminated shape and reassign arrays after splicing.
  `normalizePromptTemplate` (`shared/presets.ts`) handles imports.
- `select` option `labelKey` has no fallback label. Missing locale keys fall back to English only because
  `changeLanguage` merges.
- `changeToPreset(id)` with an id that is not in `settings.presets` does nothing: no selection change, no preset
  written.
- A prompt preset's `archived` (`PROMPT_PRESET_LOCAL_FIELDS`) filters the two list views and Ctrl+1..9 numbering only;
  selection, chat bindings, and `presetChain` read the whole list.
- `selectedLoreBookPage()` answers the selected global lorebook page while it is inside the list; past the end it
  answers 0 and stores page 0 at once (`selectLoreBookPage`).
- `forceReplaceUrl2` is legacy-only: it is excluded from `PRESET_FIELDS` and dropped by `normalizePreset`; current
  exports omit it.
- `PromptSettings.svelte` reads a missing `activePreset.promptTemplate` as an empty list for display, checks, and token
  counts, and its mount writes nothing.

## Recipes

- Add a declarative setting:
  1. `Database`, its place in `shared/sections.ts`, and its default in the server normalizer.
  2. A `SettingItem` in the page's data file (`src/ts/setting/*Data.ts` or `*Data.svelte.ts`).
  3. The English key in `src/lang/en.ts`, plus optional locale keys.
  4. Verify `pnpm check`, loading an old DB, language switching, and settings search.
- Add a setting to a sectioned page: add the `SettingItem` to the page's leaf array as above, then its id to the
  section's `itemsById` list (right under the item its condition reads, if any). A new section needs a page-unique `id`
  and `en.ts` keys for its title and any description or badge. `src/ts/setting/settingsPageSections.test.ts` fails on an
  unplaced or doubled item; a new sectioned page goes into its `PAGES`.
- Add a custom-UI setting: register an ID in `customComponents.ts`, then use `type:'custom'`, `componentId`, and
  `componentProps`.
- Add a preset field: see Invariants. Verify switching, hotkeys, and export/import.
- Add a string: add it to `en.ts`, use it as `language.<path>`, and optionally add partial locale entries. A feature's
  strings are documented by its owning guide (for example the export alerts `exportMissingAssets` and
  `jsonExportTooLarge`, with Korean overrides, in [characters-modules](characters-modules.md)).
- Expose a new language:
  1. Add the locale file.
  2. Add a `changeLanguage` branch.
  3. Add the option in `languageSettingsData.svelte.ts` and in `BROWSER_UI_LANGUAGES` (`src/ts/bootstrap.ts`, the first
     boot's browser-language match).
  4. No download step: locales are bundled. The download in `Flows` is the `translang` entry's export for translators;
     add the code to that handler's `langs` list only to offer the language for continued translation.

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/setting src/lib/Setting src/ts/storage/tests/settingsViews.test.ts src/ts/storage/tests/settingWrappers.test.ts src/lib/UI/GUI/guiRendering.test.ts`.
- `slow`: none in this area.
- `e2e`: `e2e/settingsPages.spec.ts` (page mounting, subsequent no-write traversal, and control writes),
  `e2e/presetSelection.spec.ts` (an edit in the real settings UI followed by a hotkey switch; the selection per client
  and per tab), `e2e/chatBinding.spec.ts` (the real Model Presets and Prompt Presets pickers bind the chat, show its
  name, close, and leave the tab's selection alone).
- `installFlatDatabase` (`src/ts/storage/tests/`) installs a fixture into the records, so wrapper and page tests run
  over the real views.
- `src/ts/storage/tests/settingWrappers.test.ts` mounts the wrappers and `SettingRenderer` over the production
  forwarding layer, with the global API, alerts, modules, and the parser mocked.
- `src/lib/Setting/Settings.search.test.ts` mounts the real `Settings.svelte` shell with the Model, Connections, Prompt,
  and Display pages real (the jump's consumers) and the other pages mocked.
- `src/ts/setting/settingsPageSections.test.ts` `PAGES`: the sectioned-page inventory that the placement check runs
  over.
- No focused test covers the manual `changeLanguage` branch or prompt-template editing.

## Known Hazards

### Issues

- `changeLanguage` supports `es`, but the language selector does not offer it.
- Some accessibility labels are computed from `language` at module load and do not update after a language switch.
- A conflict reload or live update of a settings record replaces its fields and resolves the selection, but runs no
  presentation update: the language (`changeLanguage`), the theme and custom CSS, the animation, and the sizes stay as
  they were until the next local change of that setting or a reload.
- Some settings controls materialize missing values when they first mount (`bindPath` creates missing containers).
  `e2e/settingsPages.spec.ts` opens every page/accordion and asserts that a second traversal writes nothing; it does not
  pin which first visits write. Collapsible sections mount only when opened.

### Gotchas

- The setting conditions read `ctx.preset` (prompt preset) or `ctx.modelPreset` (model preset): a condition on a model
  field must read `ctx.modelPreset`.
- The preset list (`botpreset.svelte`) reads every row through its record wrapper, which keeps a 50-preset reorder just
  outside its target; keyed rows made it slower, and a plain-row projection is untried
  ([preset reorder audit](../audit/preset-reorder-2026-10-05.md)).
- `pluginDevelopMode`, `forceProxyAsOpenAI`, `moveInsteadOfCopyOnCMPConvert`, and `personaNote` are persisted `ui`
  toggles with no reader and no settings item; their fields, defaults, and `shared/sections.ts` places stay for saved
  data.
- The persona note field always shows, with no `personaNote` toggle: its popup editor opens as `plaintext`, so it has no
  Preview and never counts the note's tokens.
- `globalscript` (`settings.globalscript`) and the global lore-book pages (`settings.loreBook`,
  `selectedLoreBookPage()`) have no settings page.
