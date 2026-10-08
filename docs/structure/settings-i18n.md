# Settings UI, Bot Presets, Prompt Template Editor, i18n

## Scope

- Owns:
  - the declarative settings registry and its wrappers,
  - settings navigation and pages,
  - the Model and Prompt pages and their preset lists (model and prompt presets), switching, import, and export,
  - the prompt template editor and prompt diff,
  - separate-parameter editors, quick settings,
  - language files and switching.
- Paths:
  - `src/ts/setting/*`
  - `src/lib/Setting/**`, except `Pages/Module/`, `PersonaSettings.svelte`, `listedPersona.svelte`, `Advanced/SettingsExportButtons.svelte`, `Advanced/CustomModelsSettings.svelte`, `PluginSettings.svelte`, `GlobalRegex.svelte`
  - `src/lang/*`
  - `src/lib/UI/PromptDataItem.svelte`
  - `src/lib/Others/{PromptDiffModal,AllSeperateParameters,QuickSettingsGUI}.svelte`
- Not here:
  - DB defaults and migration rules → `persistence.md`.
  - The prompt item runtime → `chat-pipeline.md`.
  - Translator presets → `media-aux.md`.

## Files

Declarative settings (`src/ts/setting/`):

- `types.ts`:
  - `SettingItem`: `id`, `type`, `bindKey` | `bindPath` (dotted) | `getValue(ctx)`/`setValue(value, ctx)`, `condition(ctx)`, `onChange`, `options`, `labelKey`/`fallbackLabel`, `componentId`/`componentProps`. `bindKey` is a `SettingsRootKey` (a root name the settings views serve; `pnpm check` refuses any other), and so is `bindPath`'s first segment.
  - `SettingContext`: `{settings, preset, persona, modelInfo, subModelInfo}`: the settings views, the selected preset (`activePreset`, by its own field names), and the selected persona (`activePersona`), from `src/ts/storage/settingsViews.svelte.ts`.
  - `SettingType`.
  - `SettingCategory`: unused.
- `settingRegistry.ts` `settingRegistry`: maps each `SettingType` to a wrapper component (`check`, `text`, `number`, `textarea`, `slider`, `select`, `segmented`, `color`, `header`, `button`, `accordion`, `custom`).
- `utils.ts`: `getSettingValue`, `setSettingValue` (a `bindKey`, or `bindPath`'s first segment, read and written through `readSettingsRoot`/`writeSettingsRoot`), `checkCondition`, `getLabel`, `getFullSettingsData` (settings search), `updateSettingValue` (the wrappers' write: skips an unchanged value, so `onChange` fires once per edit).
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
- `Wrappers/Setting*.svelte`: a function binding (`bind:value={() => getSettingValue(...), (v) => updateSettingValue(...)}`), so an edit is written synchronously, into the preset selected at that moment. No local copy and no write-back effect. `SettingSegmented` binds the same way.
- `Settings.svelte`: navigation. `SettingsMenuIndex` selects the page: `MODEL_SETTINGS_MENU` (1, the Model page), `PROMPT_SETTINGS_MENU` (16, the Prompt page), 13 (its prompt template editor), and the others by number (`src/ts/stores.svelte.ts`).

Pages, by kind:

| Kind        | Pages                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Declarative | `AccessibilitySettings`, `AdvancedSettings`, `ChatFormatSettings`, `LanguageSettings`                                                                                                                                                                                                                                                                                                |
| Hybrid      | `DisplaySettings`; `ModelSettings` (the model preset: model, provider and credentials, `modelParameterItems`, chat format, aux and fallback models, system replacement, additional parameters, custom flags, tools); `PromptPresetSettings` (the prompt preset: parameters tab renders `allBasicParameterItems`, prompt and others tabs handwritten)                                 |
| Handwritten | `OtherBotSettings` (image generation, TTS, memory/Hypa, backends), `PromptSettings`, `OobaSettings`, `OpenrouterSettings`, `SeparateParametersSection`, `ClaudeThinkingSeparateParams`, `HotkeySettings`, `UserSettings`, `CustomGUISettingMenu`, `ThanksPage`, `Communities`, `GlobalLoreBookSettings`, `Display/*`, `Language/TranslatorPresetSettings`, `Model/AuxModelSelectors` |

- `botpreset.svelte`: the preset list, by `kind`. `prompt` (`openPresetList`): select (`changeToPreset`), reorder, copy, add from the OAI2 template, rename, delete, import (`importPreset`), export (`downloadPreset`), diff (`PromptDiffModal`), and the Ctrl+1..9 numbers. `model` (`openModelPresetList`): select (`changeToModelPreset`), reorder, copy (`copyModelPreset`, with its `proxyKey` entry), add (`addModelPreset`), rename, and delete (`removeModelPreset`, never the last one). `App.svelte` mounts one per store. Each page's header names its selected preset and opens its list.
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

- The boot (`installBootRecords`) → `changeLanguage(settings.ui.language)`.
- `Settings.svelte` → page → `SettingRenderer` → wrapper → `setSettingValue` → a settings view → its record (the write queues the record's save).
- Preset switch: `changeToPreset(id)` → `selectPreset(id)` (prompt preset) and `changeToModelPreset(id)` → `selectModelPreset(id)` (model preset, `docs/plan/split-preset.md`). Every preset field lives in its own preset, so a switch copies nothing. The prompt switch is also triggered from `hotkey.ts` (index 1-9 mapped to the id) and `presetChain` in `sendChat` (name mapped to the id).
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
- Every other settings reader and writer in the tab (the chat screens, sidebars, first-run wizard, playground, the client process helpers, the plugin host's setting getters, `characterStore`'s HypaV3 toggle, and the mutation modules `collectionStore`/`pluginStorageStore`) uses the same views. A reader that falls back to the selection (`activePreset.id`, `activePersona.id`) keeps a captured context's ids first. The parser's CBS hosts, the plugin host's database API, `collectionStore`'s `updateSettings`, the snapshot consumers (`snapshots.svelte.ts`), the boot installation, the preset functions (`presets.svelte.ts`), and resource sync read the records too.
- The prompt preset (`botPreset`) captures prompts, `promptTemplate`, `promptSettings`, sampling and reasoning parameters, and separate parameters; the model preset (`ModelPreset`) captures model/provider, endpoints, compatibility flags, chat format, tools, `maxContext`, auxiliary models, and fallbacks.
- `language` is replaced on switch, so components that read it at module initialization keep stale strings.
- UI stores: `settingsOpen`, `SettingsMenuIndex`, `QuickSettings` (index 0 the Model page, 3 the Prompt page, 1 other bots, 2 modules), `CustomGUISettingMenuStore`, `openPresetList`, `openModelPresetList`.

## Coupling

- Depends on `database.svelte.ts` (types, presets), `getModelInfo`/`LLMFlags`, platform flags, GUI helpers, the translator, and prompt tokenization.

## Invariants

- A new setting needs: a `Database` field, its place and default (`persistence.md`, "Add a persisted setting"), a `SettingItem` in the right data array (or handwritten UI), and an `en.ts` key.
- Keep `item.id` values unique and stable.
- Value precedence: `getValue`, then `bindPath`, then `bindKey`. `setSettingValue` creates missing path objects.
- `SettingSelect`/`SettingSegmented` reset a value whose option becomes hidden. `SettingSegmented` takes the same value sources as the other wrappers.
- A preset-owned field must be added to `botPreset` and `PRESET_DEFAULTS` in `shared/presets.ts` (the canonical list `normalizePreset` uses; a model field also to `MODEL_PRESET_FIELDS` and the `ModelPreset` type), edited on its owner's page (`ModelSettings` or `PromptPresetSettings`), and never be a secret: credentials belong in the `llmSecrets` section (`proxyKey` per model preset in its `modelPresets` map, a custom model's `key` in its `customModels` map), and `downloadPreset` blanks the endpoint fields. A credential field is edited with `src/lib/UI/GUI/SecretInput.svelte` (`path` a `shared/llmSecrets.ts` `SecretPath`): it shows the stored key's status (set with its last four characters, not set, saving), replaces it on Enter or the button (once; the field empties), and clears it; the draft is dropped when the path changes. Never `bind:` an LLM credential field (an `llmSecrets` credential, a preset's `proxyKey`, a custom model's `key`): it reads `""`. The forwarding layer serves `proxyKey` as a flat field of the selected model preset; `activeModelPreset` does not serve it. The auxiliary credentials of the `secrets` section are ordinary readable fields, bound like any other (`settings.secrets.<field>`).
- Preserve misspelled keys: `PresensePenalty`, `seperateParameters`, `seperateModels`, `JinjaTemplate`.
- `seperateParameters.overrides` (per-model parameters, edited only by the removed Easy Panel) stays in the preset and `providers` shape for saved data and preset files; nothing reads it.
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
- `src/lib/Setting/botpreset.test.ts` (the list in both kinds: the model list selects, adds, copies, renames, and removes model presets only, with their key entries; the prompt-only actions stay on the prompt list), `src/lib/Setting/Pages/presetPages.test.ts` (each page names its preset, opens its own list, and writes into its own preset), `src/ts/setting/botSettingsParamsData.test.ts` (each page's parameter items bind only its preset's fields).
- Not tested: prompt editing, `changeLanguage`.

## Known Hazards

- `changeLanguage` supports `es`, but the language selector does not offer it.
- Some accessibility labels are computed from `language` at module load and do not update after a language switch.
- The setting conditions read `ctx.preset` (prompt preset) or `ctx.modelPreset` (model preset): a condition on a model field must read `ctx.modelPreset`.
- A conflict reload or live update of a settings record replaces its fields and resolves the selection, but runs no presentation update: the language (`changeLanguage`), the theme and custom CSS, the animation, and the sizes stay as they were until the next local change of that setting or a reload.
- Some settings pages fill missing values with control defaults when they first mount (`bindPath` creating missing containers), so the first visit can save; a second visit writes nothing (`e2e/settingsPages.spec.ts`). Which pages write on a first visit is not pinned (the former Bot Settings page, Display, Accessibility, and Advanced were seen).
- The preset list (`botpreset.svelte`) reads every row through its record wrapper, so a 50-preset reorder re-renders through the wrappers: 17.9 ms against a 15.9–16.0 ms baseline (`measureRecords.mjs`, commit `5b47b2b3` against `35678fd4`), about 2% outside the 10% target; at commit `2f658598` it measures 17.9–18.2 ms (17.5–17.8 ms at `6fa405d1`). Keyed rows were slower (18.4–20.1 ms at `5b47b2b3`, not re-measured); a plain-row projection (each row's id, name, and image read once) was not tried.
- `SettingSegmented` reads its value tracked (unlike `SettingSelect`), so switching to a preset whose segmented value is a hidden option writes the fallback into the newly selected preset.
- `pluginDevelopMode` and `forceProxyAsOpenAI` are persisted `ui` toggles with a settings item (`advancedSettingsData.ts`) and no reader.
