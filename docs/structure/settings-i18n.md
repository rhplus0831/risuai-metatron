# Settings UI, Bot Presets, Prompt Template Editor, i18n

## Scope

- Owns:
  - the declarative settings registry and its wrappers,
  - settings navigation and pages,
  - the Model and Prompt pages and their preset lists (model and prompt presets), switching, import, and export,
  - the prompt template editor and prompt diff,
  - language files and switching.
- Paths:
  - `src/ts/setting/*`
  - `src/lib/Setting/**`, except `Pages/Module/` (the module catalog, its share button's export and alert handling, and the editor: [characters-modules](characters-modules.md)), `PersonaSettings.svelte`, `listedPersona.svelte`, `Advanced/SettingsExportButtons.svelte`, `Advanced/CustomModelsSettings.svelte`, `ApiKeysSettings.svelte` (`llm-requests.md`), `PluginSettings.svelte`, `Pages/Translation/TranslatorPresetSettings.svelte`, `Pages/Model/AuxModelSelectors.svelte` (the last two belong to [media-aux](media-aux.md))
  - `src/lang/*`
  - `src/lib/UI/PromptDataItem.svelte`
  - `src/lib/Others/PromptDiffModal.svelte`
- Not here:
  - DB defaults and migration rules → `persistence.md`.
  - The prompt item runtime → `chat-pipeline.md`.
  - Translator presets → `media-aux.md`.

## Files

Declarative settings (`src/ts/setting/`):

- `types.ts`:
  - `SettingItem`: `id`, `type`, `bindKey` | `bindPath` (dotted) | `getValue(ctx)`/`setValue(value, ctx)`, `condition(ctx)`, `onChange`, `options`, `labelKey`/`fallbackLabel`, `componentId`/`componentProps`. `bindKey` is a `SettingsRootKey` (a root name the settings views serve; `pnpm check` refuses any other), and so is `bindPath`'s first segment.
  - `SettingContext`: `{settings, preset, modelPreset, modelProfile, persona, modelInfo, subModelInfo}`: the settings views, the selected preset (`activePreset`, by its own field names), and the selected persona (`activePersona`), from `src/ts/storage/settingsViews.svelte.ts`.
  - `SettingType`.
  - `SettingSection`: `id`, `labelKey`, `descriptionKey?`, `badgeKey?`, `collapsible?`, `items` (a named group on a sectioned page; ids independent of item ids).
  - `SettingCategory`: unused.
- `sections.ts` `itemsById(source, ids)`: the items of a leaf array by id, in the order asked, the same objects; throws on an unknown or repeated id. Apart from `utils.ts`, which imports the data arrays that call it.
- `settingRegistry.ts` `settingRegistry`: maps each `SettingType` to a wrapper component (`check`, `text`, `number`, `textarea`, `slider`, `select`, `segmented`, `color`, `header`, `button`, `accordion`, `custom`).
- `utils.ts`: `getSettingValue`, `setSettingValue` (a `bindKey`, or `bindPath`'s first segment, read and written through `readSettingsRoot`/`writeSettingsRoot`), `checkCondition`, `getLabel` (over `languageText(key)`, a flat `language` key or `""`), `settingContext` (the context both renderers build), `sectionHasVisibleItems`, `getFullSettingsData` (the catalog: every page's leaf arrays, the Language and Translation ones included; the settings search it was written for has no UI), `updateSettingValue` (the wrappers' write: skips an unchanged value, so `onChange` fires once per edit).
- `customComponents.ts` `customComponents`: maps component IDs to components for `type:'custom'`.
- Data arrays:
  - `accessibilitySettingsData.ts` (also `acc.newChatBinding`, how a new chat starts, [chat bindings](persistence.md): a segmented choice whose `getValue` reads anything but `empty` as `inherit`, as the creation does)
  - `advancedSettingsData.ts`: `advancedSettingsItems` (the leaf array; also `adv.requestHistoryContent` and `adv.requestHistoryLimit`, the server request history's `providers` settings, 10–10,000, [diagnostics](diagnostics.md)), `advancedSettingsHeader` (`adv.header`, `adv.warn`), and `advancedSettingsSections`: Feature access, Performance & media, Requests & tools, a temporary Other settings (the items later settings UI plan slices move elsewhere, and `adv.localNetworkMode`/`adv.localNetworkTimeout`; slice 4 removes it), then collapsible Developer & diagnostics, Experimental (`useExperimental` items) and Legacy (`adv.plainFetch`, a `showUnrecommended` item)
  - `botSettingsParamsData.ts` (`allBasicParameterItems`, sampling, penalty, model-specific)
  - `chatFormatSettingsData.ts`
  - `displaySettingsData.svelte.ts`
  - `languageSettingsData.svelte.ts` (`langState`, `languageSettingsItems`: the Language page, `lang.header`, `lang.uiLanguage`, `lang.restartWarn`)
  - `translationSettingsData.ts`: `translationSettingsItems` (the leaf array: `translation.header`, the translator items with their `lang.` ids, the cache buttons and their handlers, and `adv.noWaitTrans`, `acc.showTranslationLoading`, `adv.exp.googleTrans`, moved from Advanced and Accessibility by settings UI plan slice 6), `translationSettingsHeader`, and `translationSettingsSections`: Translator (`lang.translatorLang` first and unconditional, the only way to turn translation on; the rest reads `translator`/`translatorType`), Behavior, collapsible Experimental (`adv.exp.googleTrans`, `useExperimental`), Cache. With no translator language set, only the select, the two Behavior items without a condition, and (while experimental features are on) Experimental show

Components (`src/lib/Setting/`):

- `SettingRenderer.svelte`: derives the context (`settingContext`: the views and the selected preset's `aiModel`/`subModel` model info), filters by `checkCondition`, and renders `settingRegistry[item.type]` keyed by `item.id`.
- `SettingsSections.svelte` (`sections: SettingSection[]`): per section, a `<section aria-labelledby>` with an `h3`, the description, an optional badge pill, and `SettingRenderer`; a `collapsible` one is a closed `styled` `UI/Accordion` (title and badge on its button, description inside). Each wrapper carries `data-settings-section={id}`. A section whose items all fail their conditions (`sectionHasVisibleItems`, over the same context) renders nothing.
- `Wrappers/Setting*.svelte`: a function binding (`bind:value={() => getSettingValue(...), (v) => updateSettingValue(...)}`), so an edit is written synchronously, into the preset selected at that moment. No local copy and no write-back effect. `SettingSegmented` binds the same way.
- `Settings.svelte`: navigation. `SettingsMenuIndex` selects the page: `MODEL_SETTINGS_MENU` (1, the Model menu's Preset tab), `MODEL_PROFILES_SETTINGS_MENU` (18, its Connections tab), `API_KEYS_SETTINGS_MENU` (17, its API Keys tab; both in `llm-requests.md`): one sidebar entry, Model, covers the three, and `Pages/Model/ModelMenuTabs.svelte` (the heading and the tab bar each of the three pages renders) switches between them by setting the index, `PROMPT_SETTINGS_MENU` (16, the Prompt page), 13 (its prompt template editor), `TRANSLATION_SETTINGS_MENU` (21, the Translation page; its entry follows Language, 10), and the others by number (the named values live in `src/ts/settingsMenu.ts`, re-exported by `src/ts/stores.svelte.ts`; the URL slugs in `src/ts/router/routes.ts`).

Pages, by kind:

- **Declarative**: `AccessibilitySettings`, `AdvancedSettings` (sectioned: `advancedSettingsHeader`, then `SettingsSections` over `advancedSettingsSections`), `ChatFormatSettings`, `LanguageSettings` (the UI language only), `TranslationSettings` (sectioned: `translationSettingsHeader`, then `SettingsSections` over `translationSettingsSections`).
- **Hybrid**: `DisplaySettings`; `ModelSettings` (the model preset: the main and sub slot pickers (`Model/ProfileSlotSelect`), the aux models (`Model/AuxModelSelectors`), the Vertex region, the global request toggles such as response streaming, and additional parameters); `ModelProfilesSettings` (the model profiles, shown as Connections, `MODEL_PROFILES_SETTINGS_MENU`; `Model/ModelProfileEditor` edits the selected profile by id: model, `CredentialSelect`, and the model's blocks: reverse proxy, OpenRouter (`OpenrouterSettings`), local URLs, Ollama and NanoGPT, chat format, system replacement, custom flags, tools, `maxContext`, image output; [model profiles and slots](llm-requests.md)); `PromptPresetSettings` (the prompt preset: parameters tab renders `allBasicParameterItems`, prompt and others tabs handwritten).
- **Handwritten**: `OtherBotSettings` (image generation, TTS, memory/Hypa, backends), `PromptSettings`, `OobaSettings`, `OpenrouterSettings`, `HotkeySettings`, `UserSettings`, `ThanksPage`, `Display/*`, `Translation/TranslatorPresetSettings`, `Model/AuxModelSelectors`.

- `botpreset.svelte`: the preset list, by `kind`. A pick acts on what the screen shows ([chat bindings](persistence.md)): through `pickBinding`, with a chat open it binds that chat (a list opened from a binding row, `{ chatRef }`, binds that row's chat and closes when the chat is gone), at home it selects for the tab; in chat mode the list marks the chat's bound record (`pickedId`) and names the chat, and a deletion's confirmation counts the chats bound to the preset (`chatsBoundTo`) and moves only the tab's selection. `prompt` (`openPresetList`): pick, reorder, copy, add from the OAI2 template, rename, delete, import (`importPreset`), export (`downloadPreset`), diff (`PromptDiffModal`), and the Ctrl+1..9 numbers. `model` (`openModelPresetList`): pick, reorder, copy (`copyModelPreset`, the slots naming the same profiles), add (`addModelPreset`), rename, and delete (`removeModelPreset`, never the last one). `App.svelte` mounts one per store. Each page's header names its selected preset and opens its list; `BindingScopeNote.svelte` marks it "This chat" or "Not set for this chat" while a chat is open, and shows nothing at home.
- `src/ts/storage/presets.svelte.ts` `importPreset`: returns the new preset ID after a successful import, or no value when the picker is cancelled. The share receiver uses this result to consume a cached preset only after success.
- `Pages/HotkeySettings.svelte`: Settings menu index 15 renders this page at every width; below 768 px it shows `language.screenTooSmall` instead of the table. The table lists `activeHotkeys` (`hotkey.ts`), which hides `quickSettings`: Ctrl+Q only shows `language.quickSettingsRemoved` (with a Korean override) since the quick settings panel was removed ([app-shell](app-shell.md)).

Prompt and parameter editors:

- `UI/PromptDataItem.svelte`: edits one `PromptItem`.
- `Others/PromptDiffModal.svelte`: diffs the prompt templates of saved presets. Preferences are stored in `db.promptDiffPrefs`.

Languages (`src/lang/`):

- `index.ts`: `language` (a mutable export) and `changeLanguage(code)`, which merges the locale over a clone of English.
- `en.ts` `languageEnglish`: the source of truth and the type.
- `de`, `es`, `ko`, `vi`, `cn`, `zh-Hant`: `DeepPartial` overrides.

## Flows

- The boot (`installBootRecords`) → `changeLanguage(settings.ui.language)`.
- `Settings.svelte` → page → `SettingRenderer` → wrapper → `setSettingValue` → a settings view → its record (the write queues the record's save).
- Preset switch: `changeToPreset(id)` → `selectPreset(id)` (prompt preset) and `changeToModelPreset(id)` → `selectModelPreset(id)` (model preset, [preset records](persistence.md)). Every preset field lives in its own preset, so a switch copies nothing. These are the tab's selection only. The lists, `hotkey.ts` (Ctrl+1..9, index mapped to the id), and the persona pickers go through `pickBinding` instead (`src/ts/storage/chatBindingPick.ts`), which binds the open chat (`chatBindingPatch`) and selects for the tab only at home. `presetChain` re-scopes only its own job and changes neither ([chat bindings](persistence.md)).
- Language change (`languageSettingsData` `onChange`):
  1. Optionally download a translation.
  2. `changeLanguage`.
  3. Set `settings.ui.language` (the item's `ctx.settings`).
  4. Set `langState.changed`, which shows a restart warning.
- The Prompt page's preset image: the preset id is captured before the image dialog opens; a cancel changes nothing, and the image is applied only if that preset still exists.
- An imported SillyTavern preset computes `PresensePenalty` from `presence_penalty`; a missing value gives `NaN`, which `normalizePreset` replaces with its `PRESET_DEFAULTS` value before `addPreset`.

## State

- The settings records hold every setting (`persistence.md`). The pages and the registry read and write them through the views of `src/ts/storage/settingsViews.svelte.ts`; the whole-database object they replaced is gone:
  - `settings.<section>.<field>` (a section record's field), `settings.<collection>` (a collection's wrapper; an assignment replaces the record; the two selectable collections are `{ items, selectedId }`), `settings.presets`/`modules`/`plugins`/`pluginStorage`;
  - `activePreset.<field>`: the selected prompt preset under its own field names (`name`, `image`, and `PROMPT_PRESET_FIELDS`: `NAISettings`, `reasonEffort`, `regex`, ...); `activeModelPreset.<field>`: the selected model preset (`name`, `MODEL_PRESET_FIELDS`). Both with the selection rules of `persistence.md` ("The selected preset and persona"): a read resolves the selection (the first preset when it names none) and a missing value reads as a fresh copy of its default, so a change inside that copy saves nothing; a write goes to the preset selected now or is dropped. `activePersona.<field>` likewise (`name`, `icon`, `note`, `personaPrompt`, `largePortrait`). Both follow the selection: a handler that awaits captures `activePreset.id` first, and `currentPresetRecord()`/`currentPersonaRecord()` return the record itself (or `undefined`);
  - `selectedLoreBookPage()` with `selectLoreBookPage` (the page this client shows), `readSettingsRoot`/`writeSettingsRoot` for a root name (the registry, `NullableTextColorToggle`'s dynamic field).
- Every other settings reader and writer in the tab (the chat screens, sidebars, playground, the client process helpers, the plugin host's setting getters, `characterStore`'s HypaV3 toggle, and the mutation modules `collectionStore`/`pluginStorageStore`) uses the same views. A reader that falls back to the selection (`activePreset.id`, `activePersona.id`) keeps a captured context's ids first. The parser's CBS hosts, the plugin host's database API, `collectionStore`'s `updateSettings`, the snapshot consumers (`snapshots.svelte.ts`), the boot installation, the preset functions (`presets.svelte.ts`), and resource sync read the records too.
- The prompt preset (`botPreset`) captures prompts, `promptTemplate`, `promptSettings`, sampling and reasoning parameters; the model preset (`ModelPreset`) and its profiles capture model/provider, endpoints, compatibility flags, chat format, tools, `maxContext`, and auxiliary models. The prompt preset's `maxContextOverride`/`maxContextOverrideSize` (0 is unset; ticking the box seeds it from the main profile) replace the main slot's `maxContext` on the server (`forwardPresetRoots`, the main-slot request in `requestChatDataMain`) and in the tab's CBS database; the settings root `maxContext` and the plugin roots stay the profile's.
- `language` is replaced on switch, so components that read it at module initialization keep stale strings.
- The views follow the open chat: while a chat is open, `activePreset`, `activeModelPreset`, and `activePersona` (and every root name they serve) resolve that chat's bound record when it exists, else the tab's selection (`persistence.md`), so the settings pages show and edit what the open chat uses.
- UI stores: `settingsOpen`, `SettingsMenuIndex`, `openPresetList`, `openModelPresetList` (`true`, or `{ chatRef }` for a list opened for one chat).

## Coupling

- Depends on `database.svelte.ts` (types, presets), `getModelInfo`/`LLMFlags`, platform flags, GUI helpers, the translator, and prompt tokenization.

## Invariants

- A new setting needs: a `Database` field, its place and default (`persistence.md`, "Add a persisted setting"), a `SettingItem` in the right data array (or handwritten UI), and an `en.ts` key.
- Keep `item.id` values unique and stable. An item keeps its id when it moves to another section or page; section ids are separate and unique across pages.
- A moved item's definition moves to its new page's data file (its leaf array), keeping its id, and leaves its old leaf array, so it disappears from its old page by itself.
- A page's sections are built with `itemsById` from its leaf arrays, never from copies; the leaf arrays stay in `getFullSettingsData`, which lists each item once.
- A section is collapsible only for developer, experimental, and legacy (or similarly rare) groups; ordinary sections stay visible. A custom component with its own accordion (`BanCharacterSetSettings`, `CustomModelsSettings`) takes `componentProps: { noAccordion: true }` when it sits in a collapsible section. A conditional item stays in the section of the item its condition reads; a page-wide gate is exempt (the Translation page's `translator`/`translatorType`, which most of its items read: Behavior and Cache sit in their own sections and hide with it).
- Value precedence: `getValue`, then `bindPath`, then `bindKey`. `setSettingValue` creates missing path objects.
- `SettingSelect`/`SettingSegmented` reset a value whose option becomes hidden. `SettingSegmented` takes the same value sources as the other wrappers.
- A preset-owned field must be added to `botPreset` and `PRESET_DEFAULTS` in `shared/presets.ts` (the canonical list `normalizePreset` uses; a field of how a model is reached or what it accepts goes to `MODEL_PROFILE_FIELDS` and the `ModelProfile` type instead, a slot choice to `MODEL_PRESET_FIELDS` and the `ModelPreset` type), edited on its owner's page (`ModelProfilesSettings`, `ModelSettings`, or `PromptPresetSettings`), and never be a secret: credentials belong in the `llmSecrets` section (a named key in its `credentials` map, bound by a profile's `credentialId`), and `downloadPreset` blanks the endpoint fields. A credential field is edited with `src/lib/UI/GUI/SecretInput.svelte` (`path` a `shared/llmSecrets.ts` `SecretPath`): it shows the stored key's status (set with its last four characters, not set, saving), replaces it on Enter or the button (once; the field empties), and clears it; the draft is dropped when the path changes. Never `bind:` an LLM credential field (an `llmSecrets` credential): it reads `""`. A profile field is bound through `profileForSlot({ profileId })` (or `activeMainProfile`), never through its root name, so editing a profile that is not in the main slot works. The auxiliary credentials of the `secrets` section are ordinary readable fields, bound like any other (`settings.secrets.<field>`).
- Preserve misspelled keys: `PresensePenalty`, `seperateParameters`, `seperateModels`, `JinjaTemplate`.
- `seperateParametersEnabled` and `seperateParameters` (the removed per-role parameters, with `overrides`, the per-model parameters of the removed Easy Panel) stay in the preset and `providers` shape for saved data and preset files; nothing reads or edits them.
- Prompt edits must keep the `PromptItem` discriminated shape and reassign arrays after splicing. `normalizePromptTemplate` (`shared/presets.ts`) handles imports.
- `select` option `labelKey` has no fallback label. Missing locale keys fall back to English only because `changeLanguage` merges.
- `changeToPreset(id)` with an id that is not in `settings.presets` does nothing: no selection change, no preset written.
- `selectedLoreBookPage()` answers the selected global lorebook page while it is inside the list; past the end it answers 0 and stores page 0 at once (`selectLoreBookPage`).
- `forceReplaceUrl2` has no reader: it is not in `PRESET_FIELDS`, so `normalizePreset` drops it, and the preset export (`downloadPreset`, the JSON and `.risup` formats alike) still writes it blank for older readers.
- The registry has four item-level `getValue`/`setValue` pairs, the custom quotes (leading and trailing, double and single); every other item binds through `bindPath`.
- `PromptSettings.svelte` reads a missing `activePreset.promptTemplate` as an empty list for display, checks, and token counts, and its mount writes nothing.

## Recipes

- Add a declarative setting:
  1. `Database`, its place in `shared/sections.ts`, and its default in the server normalizer.
  2. A `SettingItem` in `*SettingsData.ts`.
  3. The English key in `src/lang/en.ts`, plus optional locale keys.
  4. Verify `pnpm check`, loading an old DB, language switching, and settings search.
- Add a setting to a sectioned page: add the `SettingItem` to the page's leaf array as above, then its id to the section's `itemsById` list (right under the item its condition reads, if any). A new section needs a page-unique `id` and `en.ts` keys for its title and any description or badge. `src/ts/setting/settingsPageSections.test.ts` fails on an unplaced or doubled item; a new sectioned page goes into its `PAGES`.
- Add a custom-UI setting: register an ID in `customComponents.ts`, then use `type:'custom'`, `componentId`, and `componentProps`.
- Add a preset field: see Invariants. Verify switching, hotkeys, and export/import.
- Add a string: add it to `en.ts`, use it as `language.<path>`, and optionally add partial locale entries. A feature's strings are documented by its owning guide (for example the export alerts `exportMissingAssets` and `jsonExportTooLarge`, with Korean overrides, in [characters-modules](characters-modules.md)).
- Expose a new language:
  1. Add the locale file.
  2. Add a `changeLanguage` branch.
  3. Add the option in `languageSettingsData.svelte.ts` and in `BROWSER_UI_LANGUAGES` (`src/ts/bootstrap.ts`, the first boot's browser-language match).

## Tests

- `src/ts/translator/presets.test.ts` (adjacent), `src/lib/UI/GUI/guiRendering.test.ts` (primitives).
- `src/ts/storage/tests/settingsViews.test.ts` (the views, the root resolver, the registry over the real context), `src/ts/storage/tests/settingWrappers.test.ts` (the wrappers and `SettingRenderer`), `src/lib/Setting/Pages/PersonaSettings.test.ts`; listed in `persistence.md`.
- `src/lib/Setting/botpreset.test.ts` (the list in both kinds: the model list selects, adds, copies, renames, and removes model presets only, with their key entries; the prompt-only actions stay on the prompt list), `src/lib/Setting/Pages/presetPages.test.ts` (each page names its preset, opens its own list, and writes into its own preset; the Connections tab's delete confirmation lists the translator presets with a step on the profile, disabled steps included, each once, translation slice 3.1), `src/ts/setting/botSettingsParamsData.test.ts` (each page's parameter items bind only its preset's fields).
- `src/lib/Setting/Settings.hotkeys.test.ts` (happy-dom, `Settings.svelte` mounted with the other pages mocked and `HotkeySettings` real; slice 4f, audit WEB-03): menu index 15 at 390 and 767 px shows `language.screenTooSmall` and no table; at 768 and 1024 px the table has one row per active hotkey, labelled by `language.hotkeyDesc`, and no message.
- `src/ts/setting/settingsPageSections.test.ts` (no DOM; settings UI plan slices 2 and 6): item ids unique across the catalog, section ids unique across the sectioned pages (`PAGES`: Advanced, Translation), every leaf item of the sectioned pages placed in exactly one section across them as the same object (page header items excepted; each page's header and sections built from its own leaf arrays), the section keys present in `en.ts`, the dependent pairs (`adv.dynAssets`/`adv.dynAssetsEdit`, `adv.promptInfo`/`adv.promptTextInfo`, `lang.translatorLang`/`lang.translatorType`, `lang.translatorType` with each DeepL, DeepLX, LLM, and Google field, `lang.llmTranslationTarget`/`lang.translatorHistoryMaxTokens`) in one section, `lang.translatorLang` first in Translation's first section with no condition, and `itemsById` throwing on an unknown or repeated id. `src/lib/Setting/SettingsSections.test.ts` (happy-dom): an ordinary section is a `section` labelled by its `h3`, a collapsible one starts closed with its badge, a section whose items all hide renders nothing. `src/ts/setting/translationSettingsData.test.ts` (the translator items' conditions and the history budget): [media-aux](media-aux.md).
- Not tested: prompt editing, `changeLanguage`.

## Known Hazards

- `changeLanguage` supports `es`, but the language selector does not offer it.
- Some accessibility labels are computed from `language` at module load and do not update after a language switch.
- The setting conditions read `ctx.preset` (prompt preset) or `ctx.modelPreset` (model preset): a condition on a model field must read `ctx.modelPreset`.
- A conflict reload or live update of a settings record replaces its fields and resolves the selection, but runs no presentation update: the language (`changeLanguage`), the theme and custom CSS, the animation, and the sizes stay as they were until the next local change of that setting or a reload.
- Some settings pages fill missing values with control defaults when they first mount (`bindPath` creating missing containers), so the first visit can save; a second visit writes nothing (`e2e/settingsPages.spec.ts`). Which pages write on a first visit is not pinned (the former Bot Settings page, Display, Accessibility, and Advanced were seen). Items in a collapsible section mount, and can write, only when it is opened (the spec opens every accordion).
- The preset list (`botpreset.svelte`) reads every row through its record wrapper, so a 50-preset reorder re-renders through the wrappers: 17.9 ms against a 15.9–16.0 ms baseline (`measureRecords.mjs`, commit `5b47b2b3` against `35678fd4`), about 2% outside the 10% target; at commit `2f658598` it measures 17.9–18.2 ms (17.5–17.8 ms at `6fa405d1`). Keyed rows were slower (18.4–20.1 ms at `5b47b2b3`, not re-measured); a plain-row projection (each row's id, name, and image read once) was not tried.
- `SettingSegmented` reads its value tracked (unlike `SettingSelect`), so switching to a preset whose segmented value is a hidden option writes the fallback into the newly selected preset.
- `pluginDevelopMode`, `forceProxyAsOpenAI`, and `moveInsteadOfCopyOnCMPConvert` are persisted `ui` toggles with no reader and no settings item (removed from the UI by settings UI plan slice 1); their fields, defaults, and `shared/sections.ts` places stay for saved data. `globalscript` (`settings.globalscript`) and the global lore-book pages (`settings.loreBook`, `selectedLoreBookPage()`) have no settings page either: menu indexes 7–9 (Communities, global lore book, global regex) were unreachable and are gone.
