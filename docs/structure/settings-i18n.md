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
  - `src/lib/Setting/**`, except the files other guides own (`pnpm docs:owner <path>`):
    - [characters-modules](characters-modules.md): `Pages/Module/` (the module catalog, its share button's export and
      alert handling, and the editor), `Pages/PersonaSettings.svelte`, `listedPersona.svelte`;
    - `llm-requests.md`: `Pages/Advanced/CustomModelsSettings.svelte`, `Pages/ApiKeysSettings.svelte`,
      `Pages/ModelProfilesSettings.svelte`, `Pages/Model/ModelProfileEditor.svelte`,
      `Pages/Model/ProfileSlotSelect.svelte`;
    - `backup-sync-hub.md`: `Pages/Advanced/SettingsExportButtons.svelte`; `diagnostics.md`:
      `Pages/Advanced/DiagnosticsPanel.svelte`; `plugin-sandbox.md`: `Pages/PluginSettings.svelte`;
    - [translation](translation.md): `Pages/TranslationSettings.svelte`,
      `Pages/Translation/TranslatorStepEditor.svelte`, `Pages/Translation/TranslatorPresetSettings.svelte`;
      [media-aux](media-aux.md): `Pages/Model/AuxModelSelectors.svelte`; structured memory:
      `Pages/StructuredMemoryPrompts.svelte`.
  - `src/lang/*`
  - `src/lib/UI/PromptDataItem.svelte`
  - `src/lib/Others/PromptDiffModal.svelte`
- Not here:
  - DB defaults and migration rules → `persistence.md`.
  - The prompt item runtime → `chat-pipeline.md`.
  - Translator settings and provider steps → `translation.md`.

## Files

Each module's rules are in its header or on its exports, and each component's in a JSDoc block at the top of its
`<script>`.

### Registry and helpers

- `src/ts/setting/types.ts`: the schema, `SettingItem`, `SettingContext`, `SettingSection`, `SettingType`,
  `SettingOptions`. `bindKey` and `bindPath`'s first segment are a `SettingsRootKey` of
  `src/ts/storage/settingsViews.svelte.ts`.
- `src/ts/setting/sections.ts` `itemsById`: a section's items, taken from a leaf array.
- `src/ts/setting/settingRegistry.ts` `settingRegistry` (a `SettingType` to its wrapper) and
  `src/ts/setting/customComponents.ts` `customComponents` (a `componentId` to its component, for `type:'custom'`).
- `src/ts/setting/utils.ts`: `getSettingValue`, `setSettingValue`, `updateSettingValue` (the wrappers' write),
  `checkCondition`, `getLabel`, `settingContext` (the context both renderers build), `sectionHasVisibleItems`, and
  `getFullSettingsData` (the catalog search reads).

### Settings search and jumps

- `src/ts/setting/searchIndex.ts` (no runes or DOM): `SETTING_LOCATIONS`, `settingLocation`, `SettingOpener`,
  `SettingHit`, `searchSettings`, `SETTING_HIT_LIMIT`. It places items from the same header arrays, sections, and leaf
  arrays the pages render, so a placed item is indexed with no further edit ([Recipes](#recipes)); ranking uses
  `src/ts/util/koreanSearch.ts` `matchText`.
- `src/ts/setting/settingJump.svelte.ts`: `openSetting` (the in-app deep link, from a `SettingHit`), `jumpVersion`,
  `currentJump`, `finishJump`, `scrollToSetting`, `scrollToSection`, `SETTING_HIGHLIGHT_MS`.
- A jump's mount-time consumers: `src/lib/Setting/Settings.svelte` (keys the page, runs the jump),
  `src/lib/Setting/SettingsSections.svelte` (a collapsible section), `src/lib/Setting/Pages/ModelSettings.svelte` and
  the Model profile editor and Connections page ([LLM](llm-requests.md)),
  `src/lib/Setting/Pages/PromptPresetSettings.svelte` (the tab), and `src/lib/Setting/Pages/DisplaySettings.svelte` (the
  tab, through `requestDisplayTab`).

### Data arrays

- An item's id prefix names the page it came from, not the page it sits on: search the id before assuming its page
  (`acc.`, `adv.`, and `display.` ids sit on several pages).
- Page data: `src/ts/setting/accessibilitySettingsData.ts`, `src/ts/setting/interactionSettingsData.ts`,
  `src/ts/setting/advancedSettingsData.ts`, `src/ts/setting/translationSettingsData.ts`,
  `src/ts/setting/chatFormatSettingsData.ts`, `src/ts/setting/memorySettingsData.ts`,
  `src/ts/setting/voiceSettingsData.ts`.
- `src/ts/setting/displaySettingsData.svelte.ts` (Display's tabs and sections, `requestDisplayTab`,
  `takeRequestedDisplayTab`); `src/ts/setting/modelSettingsData.ts` and `src/ts/setting/promptSettingsData.ts` (global
  items below the Model and Prompt pages' handwritten controls); `src/ts/setting/botSettingsParamsData.ts`
  (`allBasicParameterItems`, `modelParameterItems`); `src/ts/setting/languageSettingsData.svelte.ts` (`langState`, the
  `translang` export).
- Items sit in one leaf array and are placed by id ([Recipes](#recipes)).

### Renderers and credential links

- `src/lib/Setting/SettingRenderer.svelte` (items to wrappers, the `data-setting-id` anchor) and
  `src/lib/Setting/SettingsSections.svelte` (`SettingSection[]`, the `data-settings-section` anchor).
- `src/lib/Setting/Wrappers/Setting*.svelte`: each binds with a function binding,
  `bind:value={() => getSettingValue(...), (v) => updateSettingValue(...)}`, with no local copy, so an edit lands in the
  binding's record as selected at that moment. Only `SettingSelect` and `SettingSegmented` also write from an effect,
  their reset ([Invariants](#invariants)).
- `src/ts/setting/credentialLinks.ts`: `CREDENTIAL_OWNERS` (a shared credential's one editing place),
  `openCredentialOwner`, `takeCredentialRequest`, `scrollToCredential`. `src/lib/Setting/CredentialStatusLink.svelte` is
  the status and "Edit in …" link elsewhere.

### Settings navigation

- `src/lib/Setting/Settings.svelte`: `navGroups`, the search field (`language.settingsSearch`), the page keyed by the
  menu and `jumpVersion()`, and the jump attachment.
- `SettingsMenuIndex` selects the page: the named values in `src/ts/settingsMenu.ts` (re-exported by
  `src/ts/stores.svelte.ts`), the URL slugs in `src/ts/router/routes.ts` ([app-shell](app-shell.md)). Other pages go by
  number, such as 13, the prompt template editor.
- `src/lib/Setting/Pages/Model/ModelMenuTabs.svelte`: the Model menu, one sidebar entry over Preset, Connections, and
  API Keys (the last two in `llm-requests.md`).

### Pages

These live in `src/lib/Setting/Pages/`. `Display/HandoffToggles.svelte` edits device stores in
`src/ts/network/handoff.ts`, using `serverJob.handoff` strings; its custom registry item belongs to the notification
section.

- Declarative: `AccessibilitySettings`, `InteractionSettings`, and `AdvancedSettings` (the header array, then
  `SettingsSections`), `DisplaySettings` (sectioned per tab), `ChatFormatSettings`, and `LanguageSettings` (the UI
  language only).
- Hybrid handwritten/registry pages: `ModelSettings` (the model preset and the aux selector owned by
  [media-aux](media-aux.md)) and `PromptPresetSettings` (the prompt preset). Connections, profile editing, and slot
  selection belong to [LLM requests](llm-requests.md).
- `MemorySettings`: memory providers, presets, the embedding model, `supaMemoryKey`, and the HypaV3 budget controls.
  Summarization, budget, and task behavior belong to [memory](memory.md), the structured-memory branch to
  [writer settings](structured-memory/writer.md#state); the prompt-preset max-context override it reads is in
  [State](#state).
- `ImageGenerationSettings` (provider controls, `NAIApiKey`, WaveSpeed LoRA rows) and `VoiceSettings` (TTS, Emotion
  Images): runtime behavior is in [media](media-aux.md).
- `HotkeySettings` (menu 15): `activeHotkeys` (`src/ts/hotkey.ts`) hides `quickSettings` ([app-shell](app-shell.md)).
- Other handwritten pages: `PromptSettings`, `OobaSettings`, `OpenrouterSettings`, `UserSettings`, `ThanksPage`,
  `UpstreamImportReport`, `Advanced/BanCharacterSetSettings`, `Advanced/StoragePanel`, and `Display/*`.

### Preset lists

- `src/lib/Setting/botpreset.svelte` (both preset lists) and `src/lib/Setting/BindingScopeNote.svelte`. `App.svelte`
  mounts one list per store (`openPresetList`, `openModelPresetList`).
- A pick uses `pickBinding` (`src/ts/storage/chatBindingPick.ts`): it binds the open chat, or changes the tab selection
  at home ([chat bindings](persistence.md)). Ctrl+1..9 and persona pickers use the same path.
- `src/ts/storage/presets.svelte.ts` `importPreset` returns the new id after success, or no value for a cancelled picker
  or a refused file (alerted). The share receiver consumes its cached preset only after success.

### Prompt editors

- `src/lib/UI/PromptDataItem.svelte` (one `PromptItem`) and `src/lib/Others/PromptDiffModal.svelte` (saved presets'
  templates, preferences in `db.promptDiffPrefs`).

### Languages

- `src/lang/index.ts` `language` (a mutable export) and `changeLanguage(code)`; `src/lang/en.ts` `languageEnglish` (the
  source of truth and the type); `de`, `es`, `ko`, `vi`, `cn`, `zh-Hant`: `DeepPartial` overrides. Exposing a language:
  [Recipes](#recipes).
- Strings a feature owns are documented beside their key and by that feature's guide: `serverAuth`
  (`src/ts/storage/serverAuth.ts`) and `help.keepSessionAlive` ([app shell](app-shell.md)).

## Flows

- Boot installs records before `changeLanguage(settings.ui.language)`. A registry edit goes through its wrapper and the
  settings view to the owning record, which queues the save.
- Search: `searchSettings` → `openSetting` → keyed page mount → `currentJump()` → scroll/highlight or unavailable note →
  `finishJump` (an available page or tab hit only navigates), across `src/ts/setting/searchIndex.ts`,
  `src/ts/setting/settingJump.svelte.ts`, and the consumers in [Settings search and jumps](#settings-search-and-jumps).
- Preset switching changes the selected record; picking uses `pickBinding` and may update an open chat's binding. The
  field and chat-binding rules are in [persistence](persistence.md#settings-records).
- A language switch is the `lang.uiLanguage` `onChange` in `src/ts/setting/languageSettingsData.svelte.ts`.
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

- A synced setting needs a `Database` field, ownership and default (`persistence.md`, "Add a persisted setting"), a
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
- `SettingSelect`/`SettingSegmented` reset, at mount and when their visible options change, a value whose option is
  hidden. Both read and write that value untracked, so a preset switch that leaves the options as they are does not
  reset it: a preset holding a hidden option (for example `thinkingType: "adaptive"` under a budget-only Claude model)
  keeps it. Both track only the visible option values (`JSON.stringify`), so a context rebuilt with the same options (a
  fresh model info after a chat's prompt binding changes) does not run the reset.
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
  3. Add the option in `languageSettingsData.svelte.ts`. For the first boot (`src/ts/bootstrap.ts`), add a base code to
     `BROWSER_UI_LANGUAGES` or map browser tags in `BROWSER_UI_LANGUAGE_MAP`.
  4. No download step: locales are bundled. The `translang` download (`lang.uiLanguage`'s `onChange`) exports for
     translators; list the code in its `langs` only to offer it for translation.

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/setting src/lib/Setting src/ts/storage/tests/settingsViews.test.ts src/ts/storage/tests/settingWrappers.test.ts src/lib/UI/GUI/guiRendering.test.ts src/lang`.
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
- `src/lang/triggerDescPlaceholders.test.ts`: every locale's `triggerDesc` names the same `{{field}}` placeholders as
  English, since `TriggerV2List` fills them from the effect's fields by name.
- No focused test covers the manual `changeLanguage` branch or prompt-template editing past a type switch.

## Known Hazards

### Issues

- `src/lang/index.ts` supports Spanish through `changeLanguage`, but `src/ts/setting/languageSettingsData.svelte.ts`
  does not offer `es` in the UI-language selector.
- The new-message button style labels in `src/ts/setting/accessibilitySettingsData.ts` are copied from `language` at
  module load, so they stay in the original language after a switch.
- A remote or conflict replacement of the `ui` record does not apply a new `settings.ui.language`: `src/ts/bootstrap.ts`
  `watchRemoteRecords` reapplies the color scheme, text theme/CSS, animation, and sizes, but does not call
  `changeLanguage`.
- Unconfirmed: some settings controls may materialize missing values when first mounted (`bindPath` creates missing
  containers). `e2e/settingsPages.spec.ts` checks that a second traversal writes nothing, but does not identify any
  first-visit writes. Collapsible sections mount only when opened.

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
