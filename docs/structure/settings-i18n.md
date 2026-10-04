# Settings UI, Bot Presets, Prompt Template Editor, i18n

## Scope

- Owns:
  - the declarative settings registry and its wrappers,
  - settings navigation and pages,
  - bot preset list, switching, import, and export,
  - the prompt template editor and prompt diff,
  - separate-parameter editors, quick settings, EasyPanel,
  - language files and switching.
- Paths:
  - `src/ts/setting/*`
  - `src/lib/Setting/**`, except `Pages/Module/`, `PersonaSettings.svelte`, `listedPersona.svelte`, `Advanced/SettingsExportButtons.svelte`, `Advanced/CustomModelsSettings.svelte`, `PluginSettings.svelte`, `GlobalRegex.svelte`
  - `src/lang/*`
  - `src/lib/UI/PromptDataItem.svelte`
  - `src/lib/Others/{PromptDiffModal,AllSeperateParameters,QuickSettingsGUI}.svelte`
  - `src/lib/Others/ProTools/EasyPanel.svelte`
- Not here:
  - DB defaults and migration rules → `persistence.md`.
  - The prompt item runtime → `chat-pipeline.md`.
  - Translator presets → `media-aux.md`.

## Files

Declarative settings (`src/ts/setting/`):

- `types.ts`:
  - `SettingItem`: `id`, `type`, `bindKey` | `bindPath` (dotted) | `getValue(ctx)`/`setValue(value, ctx)`, `condition(ctx)`, `onChange`, `options`, `labelKey`/`fallbackLabel`, `componentId`/`componentProps`. `bindKey` is a `SettingsRootKey` (a root name the settings views serve; `pnpm check` refuses any other), and so is `bindPath`'s first segment.
  - `SettingContext`: `{settings, preset, persona, modelInfo, subModelInfo}` (Phase 6 slice 6): the settings views, the selected preset (`activePreset`, by its own field names), and the selected persona (`activePersona`), from `src/ts/storage/settingsViews.svelte.ts`.
  - `SettingType`.
  - `SettingCategory`: unused.
- `settingRegistry.ts` `settingRegistry`: maps each `SettingType` to a wrapper component (`check`, `text`, `number`, `textarea`, `slider`, `select`, `segmented`, `color`, `header`, `button`, `accordion`, `custom`).
- `utils.ts`: `getSettingValue`, `setSettingValue` (a `bindKey`, or `bindPath`'s first segment, read and written through `readSettingsRoot`/`writeSettingsRoot`), `checkCondition`, `getLabel`, `getFullSettingsData` (search and custom sidebar), `updateSettingValue` (the wrappers' write: skips an unchanged value, so `onChange` fires once per edit).
- `customComponents.ts` `customComponents`: maps component IDs to components for `type:'custom'`.
- Data arrays:
  - `accessibilitySettingsData.ts`
  - `advancedSettingsData.ts`
  - `botSettingsParamsData.ts` (`allBasicParameterItems`, sampling, penalty, model-specific)
  - `chatFormatSettingsData.ts`
  - `displaySettingsData.svelte.ts`
  - `languageSettingsData.svelte.ts` (`langState`, `languageSettingsItems`)

Components (`src/lib/Setting/`):

- `SettingRenderer.svelte`: derives the context (the views and the selected preset's `aiModel`/`subModel` model info), filters by `checkCondition`, and renders `settingRegistry[item.type]` keyed by `item.id`.
- `Wrappers/Setting*.svelte`: a function binding (`bind:value={() => getSettingValue(...), (v) => updateSettingValue(...)}`), so an edit is written synchronously, into the preset selected at that moment. No local copy and no write-back effect. `SettingSegmented` binds the same way (since slice 6; it bound its `bindKey` directly before).
- `Settings.svelte`: navigation. `SettingsMenuIndex` selects the page.

Pages, by kind:

| Kind        | Pages                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Declarative | `AccessibilitySettings`, `AdvancedSettings`, `ChatFormatSettings`, `LanguageSettings`                                                                                                                                                                                                                                                                                                |
| Hybrid      | `DisplaySettings`; `BotSettings` (model, prompt, and other tabs handwritten; the parameters tab renders `allBasicParameterItems`)                                                                                                                                                                                                                                                    |
| Handwritten | `OtherBotSettings` (image generation, TTS, memory/Hypa, backends), `PromptSettings`, `OobaSettings`, `OpenrouterSettings`, `SeparateParametersSection`, `ClaudeThinkingSeparateParams`, `HotkeySettings`, `UserSettings`, `CustomGUISettingMenu`, `ThanksPage`, `Communities`, `GlobalLoreBookSettings`, `Display/*`, `Language/TranslatorPresetSettings`, `Model/AuxModelSelectors` |

- `botpreset.svelte`: preset list, select (`changeToPreset`), reorder, copy, import (`importPreset`), export (`downloadPreset`), and diff (`PromptDiffModal`).
- `lorepreset.svelte`: global lore-book list.

Prompt and parameter editors:

- `UI/PromptDataItem.svelte`: edits one `PromptItem`.
- `Others/PromptDiffModal.svelte`: diffs the prompt templates of saved presets. Preferences are stored in `db.promptDiffPrefs`.
- `Others/AllSeperateParameters.svelte`: separate-parameter editor.

Languages (`src/lang/`):

- `index.ts`: `language` (a mutable export) and `changeLanguage(code)`, which merges the locale over a clone of English.
- `en.ts` `languageEnglish`: the source of truth and the type.
- `de`, `es`, `ko`, `vi`, `cn`, `zh-Hant`: `DeepPartial` overrides.

## Flows

- `setDatabase` → `changeLanguage(db.language)`.
- `Settings.svelte` → page → `SettingRenderer` → wrapper → `setSettingValue` → a settings view → its record (the write queues the record's save).
- Preset switch: `changeToPreset(id)` → `saveCurrentPreset` (the five keep-on-switch fields into the old preset, unless disabled) → `selectPreset(id)` → `setPreset` (the new preset's five fields into `providers`). Also triggered from `hotkey.ts` (index 1-9 mapped to the id) and `presetChain` in `sendChat` (name mapped to the id). Every other preset field is forwarded, so the switch copies nothing else.
- Language change (`languageSettingsData` `onChange`):
  1. Optionally download a translation.
  2. `changeLanguage`.
  3. Set `settings.ui.language` (the item's `ctx.settings`).
  4. Set `langState.changed`, which shows a restart warning.

## State

- The settings records hold every setting (`persistence.md`). The pages and the registry read and write them through the views of `src/ts/storage/settingsViews.svelte.ts` (Phase 6 slice 6), never through `DBState.db`:
  - `settings.<section>.<field>` (a section record's field), `settings.<collection>` (a collection's wrapper; an assignment replaces the record; the two selectable collections are `{ items, selectedId }`), `settings.presets`/`modules`/`plugins`/`pluginStorage`;
  - `activePreset.<field>`: the selected preset under its own field names (`NAISettings`, `reasonEffort`, `regex`; the keep-on-switch group is `settings.providers`), with the forwarding layer's rules: a read resolves the selection (the first preset when it names none) and a missing value reads as a fresh copy of its default, so a change inside that copy saves nothing; a write goes to the preset selected now or is dropped. `activePersona.<field>` likewise (`name`, `icon`, `note`, `personaPrompt`, `largePortrait`). Both follow the selection: a handler that awaits captures `activePreset.id` first, and `currentPresetRecord()`/`currentPersonaRecord()` return the record itself (or `undefined`);
  - `selectedLoreBookPage()` with `selectLoreBookPage` (the page this client shows), `readSettingsRoot`/`writeSettingsRoot` for a root name (the registry, `NullableTextColorToggle`'s dynamic field).
  - Still on `DBState.db` here: the character reads of `Pages/Module/ModuleChatMenu.svelte` and `OtherBotSettings.svelte` (slice 8, `readers-characters`).
- `botPreset` captures model/provider, prompts, `promptTemplate`, `promptSettings`, sampling parameters, templates, separate models and parameters (unless `doNotChangeSeperateModels`), tools, and fallbacks.
- `language` is replaced on switch, so components that read it at module initialization keep stale strings.
- UI stores: `settingsOpen`, `SettingsMenuIndex`, `QuickSettings`, `CustomGUISettingMenuStore`, `easyPanelStore`.

## Coupling

- Depends on `database.svelte.ts` (types, presets), `getModelInfo`/`LLMFlags`, platform flags, GUI helpers, the translator, and prompt tokenization.
- `CustomSidebar.svelte` renders arbitrary `SettingItem`s via `getFullSettingsData`, so item `id`s and conditions are part of user data.

## Invariants

- A new setting needs: a `Database` field, its place and default (`persistence.md`, "Add a persisted setting"), a `SettingItem` in the right data array (or handwritten UI), and an `en.ts` key.
- Keep `item.id` values unique and stable. User custom sidebars reference them.
- Value precedence: `getValue`, then `bindPath`, then `bindKey`. `setSettingValue` creates missing path objects.
- `SettingSelect`/`SettingSegmented` reset a value whose option becomes hidden. `SettingSegmented` takes the same value sources as the other wrappers.
- A preset-owned field must be added to `botPreset` and `PRESET_DEFAULTS` in `shared/presets.ts` (the canonical list `normalizePreset` uses), and never be a secret: credentials belong in the `llmSecrets` section (`proxyKey` per preset in its `presets` map, a custom model's `key` in its `customModels` map), and `downloadPreset` blanks the endpoint fields. A credential field is edited with `src/lib/UI/GUI/SecretInput.svelte` (Phase 5 slice 7b; `path` a `shared/llmSecrets.ts` `SecretPath`): it shows the stored key's status (set with its last four characters, not set, saving), replaces it on Enter or the button (once; the field empties), and clears it; the draft is dropped when the path changes. Never `bind:` an LLM credential field (an `llmSecrets` credential, a preset's `proxyKey`, a custom model's `key`): it reads `""`. The forwarding layer serves `proxyKey` as a flat field of the selected preset; `activePreset` does not serve it. The auxiliary credentials of the `secrets` section are ordinary readable fields, bound like any other (`settings.secrets.<field>`).
- Preserve misspelled keys: `PresensePenalty`, `seperateParameters`, `seperateModels`, `JinjaTemplate`.
- Prompt edits must keep the `PromptItem` discriminated shape and reassign arrays after splicing. `normalizePromptTemplate` (`shared/presets.ts`) handles imports.
- `select` option `labelKey` has no fallback label. Missing locale keys fall back to English only because `changeLanguage` merges.

## Recipes

- Add a declarative setting:
  1. `Database` + `setDatabase`.
  2. A `SettingItem` in `*SettingsData.ts`.
  3. The English key in `src/lang/en.ts`, plus optional locale keys.
  4. Verify `pnpm check`, loading an old DB, language switching, and settings search.
- Add a custom-UI setting: register an ID in `customComponents.ts`, then use `type:'custom'`, `componentId`, and `componentProps`.
- Add a preset field: see Invariants. Verify switching, hotkeys, and export/import.
- Add a string: add it to `en.ts`, use it as `language.<path>`, and optionally add partial locale entries.
- Expose a new language:
  1. Add the locale file.
  2. Add a `changeLanguage` branch.
  3. Add the option in `languageSettingsData.svelte.ts` and in the welcome-screen language choices.

## Tests

- `src/ts/translator/presets.test.ts` (adjacent), `src/lib/UI/GUI/guiRendering.test.ts` (primitives).
- `src/ts/storage/tests/settingsViews.test.ts` (the views, the root resolver, the registry over the real context), `src/ts/storage/tests/settingWrappers.test.ts` (the wrappers and `SettingRenderer`), `src/lib/Setting/Pages/PersonaSettings.test.ts`; listed in `persistence.md`.
- Not tested: presets, prompt editing, `changeLanguage`.

## Known Hazards

- `changeLanguage` supports `es`, but the language selector does not offer it.
- Some accessibility labels are computed from `language` at module load and do not update after a language switch.
