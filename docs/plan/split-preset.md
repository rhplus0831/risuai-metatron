# Split Preset Plan

Status: slices 1–3 implemented; slices 4–6 open. Split the single bot preset (`botPreset`, the
`presets` collection) into a **model preset** and a **prompt preset** that are
selected independently. A later step lets each chat pick its own pair.

Reference: `/home/codex/risuai-fastify` did the same split
(`e4f98e847`, `docs/split-bot-preset.md` in that commit), then had to add
"prompt presets override model settings" a day later because shared presets
carry sampling parameters, and replaced its model presets with role-based
model profiles five days later. This plan takes the lessons, not the shape:
sampling parameters live with the prompt from the start, and the model side
stays a plain preset list.

## Product decisions

1. Goal: independent switching. Model A with prompt B, and later per chat.
2. The prompt preset owns the sampling and generation parameters. A shared
   "Chat Bot" preset is a prompt-sharing artifact, so `.risup` keeps carrying
   temperature, top_p, reasoning effort, and so on.
3. The model preset owns what selects and reaches the model: model ids,
   endpoints, provider routing and compatibility, auxiliary and fallback
   models.
4. No data migration. The fork is only used for testing; existing presets keep
   their prompt fields and lose their model fields.
5. `proxyKey` (the reverse-proxy API key, today `llmSecrets.presets.<id>`)
   belongs to the model preset. Imports ignore it.

## Data model

- **Prompt preset** = the existing `presets` collection and `botPreset` type.
  Keeping it avoids touching the `.risup` format, `presetChain`, the hotkeys,
  and the persisted key names (D3, D5).
  - Its stored record keeps only `PROMPT_PRESET_FIELDS` (plus `id`, `name`,
    `image`). `normalizePreset` drops the model fields.
  - The `botPreset` type keeps the model fields as optional, for reading old
    files.
- **Model preset** = a new singleton collection, `modelPresets`
  (`RESOURCE_KIND.modelPresets`), materialized by the server with one default
  record, normalized by `normalizeModelPreset(s)` in `shared/presets.ts`, same
  rules as presets: an `id` on every record, never empty, credentials never
  stored. It holds `name` and the model fields; it has no `image` (the icon
  stays the prompt preset's).
- **One schema table**: `PRESET_DEFAULTS` stays the single table of defaults,
  kinds, and null rules for every field of both records (each field has one
  owner, so the table cannot conflict); `MODEL_PRESET_FIELDS`,
  `PROMPT_PRESET_FIELDS`, and `PRESET_RECORD_FIELDS` partition it. A separate
  model defaults table would drift.
- **Secrets**: the new `llmSecrets.modelPresets.<id>.proxyKey` map replaces
  `llmSecrets.presets`. The old map is dropped by the normalizer.
- **Selection**: `selection.modelPresetId` next to `selection.presetId`
  (per tab, `sessionStorage` + `localStorage`, never saved to the server).
  `presetId` keeps meaning the prompt preset.

### Field partition

One source of truth in `shared/`: `MODEL_PRESET_FIELDS` and
`PROMPT_PRESET_FIELDS`, with a test that they are disjoint and together equal
today's `PRESET_FIELDS` minus `name`/`image`.

Model preset:

| Group                 | Fields                                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model selection       | `aiModel`, `subModel`, `apiType`, `currentPluginProvider`                                                                                                                                           |
| Endpoints / transport | `forceReplaceUrl`, `customProxyRequestModel`, `proxyRequestModel`, `customAPIFormat`, `textgenWebUIStreamURL`, `textgenWebUIBlockingURL`, `koboldURL`, `localNetworkMode`, `localNetworkTimeoutSec` |
| Provider routing      | `openrouterRequestModel`, `openrouterProvider`, `useInstructPrompt`                                                                                                                                 |
| Compatibility         | `enableCustomFlags`, `customFlags`, `systemContentReplacement`, `systemRoleReplacement`, `instructChatTemplate`, `JinjaTemplate`, `outputImageModal`, `modelTools`                                  |
| Capacity              | `maxContext`                                                                                                                                                                                        |
| Aux / fallback        | `seperateModelsForAxModels`, `seperateModels`, `fallbackModels`, `fallbackWhenBlankResponse`                                                                                                        |

Prompt preset:

| Group               | Fields                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt text         | `mainPrompt`, `jailbreak`, `globalNote`, `formatingOrder`, `promptPreprocess`, `promptTemplate`, `promptSettings`, `customPromptTemplateToggle`, `templateDefaultVariables`, `autoSuggestPrompt`, `groupOtherBotRole`, `groupTemplate`, `NAIadventure`, `NAIappendName` |
| Prompt behavior     | `bias`, `regex`, `moduleIntergration`, `jsonSchemaEnabled`, `jsonSchema`, `strictJsonSchema`, `extractJson`, `dynamicOutput`                                                                                                                                            |
| Sampling            | `temperature`, `maxResponse`, `frequencyPenalty`, `PresensePenalty`, `top_p`, `top_k`, `min_p`, `top_a`, `repetition_penalty`, `verbosity`                                                                                                                              |
| Reasoning           | `reasonEffort`, `thinkingTokens`, `thinkingType`, `adaptiveThinkingEffort`, `deepseekThinkingType`, `deepseekReasoningEffort`                                                                                                                                           |
| Provider sampling   | `ooba`, `ainconfig`, `NAISettings`, `reverseProxyOobaArgs`, `localStopStrings`                                                                                                                                                                                          |
| Per-role parameters | `seperateParametersEnabled`, `seperateParameters`                                                                                                                                                                                                                       |

Decided placements (confirmed 2026-10-08):

- `maxContext` goes to the model, because it is bounded by the model's
  window. A shared prompt with 200k context should not overflow a 32k model.
- `systemContentReplacement`/`systemRoleReplacement`, `outputImageModal`, and
  `customFlags` go to the model because they describe what the model
  accepts.
- The JSON schema fields go to the prompt because they shape the response the
  prompt asks for.
- The request contracts keep `presetId` as the prompt preset id and add
  `modelPresetId` (fewer call sites change than a rename to
  `promptPresetId`).

Known mixed containers (recorded exceptions, not reopened): `ooba` (prompt)
also holds `ooba.formating`, the role prefixes of the Ooba text format, and
`reverseProxyOobaArgs` (prompt) is copied into the reverse-proxy request body
without an allowlist, so it can carry more than sampling. Switching the prompt
preset can therefore change those formatting details for Ooba-style models.

### Keep-on-switch retires

Today five fields live in `providers` and are copied in and out of a preset on
every switch, gated by three toggles (`PRESET_KEEP_ON_SWITCH_FIELDS`,
`copyKeepOnSwitchFields`, server `KEEP_RULES`/`applyPresetKeepRules`).
After the split they become ordinary preset fields:

- the aux/fallback four go to the model preset (switching the prompt no
  longer touches them, which is what the toggles were for);
- `seperateParameters` joins `seperateParametersEnabled` in the prompt preset.

The three toggles (`doNotChangeSeperateModels`, `doNotChangeFallbackModels`,
`disableSeperateParameterChangeOnPresetChange`) and their `providers` copies of
the five fields are removed from `SECTION_FIELDS.providers` and the server
`providers` normalizer.

## Server

- Contracts: add `modelPresetId` beside `presetId` in `GenerationContext`
  (`shared/jobs.ts`), `TransformContext` (`shared/transform.ts`),
  `LlmRequestBody.context` (`shared/llm/request.ts`), `RequestScopeIds`
  (`server/src/llm/settings.ts`), `CallbackTargets`, and the three route
  parsers (`routes/generations.ts`, `routes/llm.ts`, `routes/transform.ts`).
  Both ids are required; each missing record has its own "no longer exists"
  error.
- One shared helper (for example `applyPresetFields(db, modelPreset,
promptPreset)` in `shared/`) replaces the two `FORWARDED_PRESET_KEYS` loops in
  `jobs/jobScope.ts` and `llm/settings.ts` (`loadRequestDb`), so the two copies
  cannot drift.
- `JobScope.preset` becomes `promptPreset` + `modelPreset`. `botPresetsId` and
  the prompt-info preset name (`prompt/assemble.ts`) use the prompt preset;
  `proxyKey` is looked up by the model preset id.
- `presetChain` picks among prompt presets only and rebuilds the scope with
  only `presetId` changed; `KEEP_RULES` goes away. The `preset` job event keeps
  its shape (prompt preset id).

## Client

- `settingsViews.svelte.ts`: `activePreset` serves prompt fields only; a new
  `activeModelPreset` serves the model fields. The root routes
  (`buildRootRoutes`, `FORWARDED_PRESET_KEYS`) send each root name to its
  owner, so `readSettingsRoot`, `getDatabase`, and `updateSettings` keep
  working by name.
- `presets.svelte.ts`: `changeToPreset` loses the keep-on-switch copy; add
  `changeToModelPreset`, model preset CRUD in `collectionStore.svelte.ts`.
- Send both ids: `serverCommands.ts` (job context), `request/transport.ts`,
  `parser/transformClient.ts` (`captureTransform`), and
  `plugins/apiV3/pluginContext.ts` (capture both).
- Model reads outside settings move to `activeModelPreset`: `tokenizer.ts`,
  `request/request.ts`, `files/inlays.ts`, `model/modellist.ts`
  (`customFlags`), `Suggestion.svelte`, `DefaultChatScreen.svelte`,
  `IrisModal.svelte`, `WelcomeRisu.svelte`.

## UI

- Settings menu: "Chat Bot" becomes **Model** and **Prompt**.
  - Model: today's Model tab, aux model selectors, fallback models, custom
    flags, tools, chat format, and its own preset list.
  - Prompt: today's Parameters and Prompt tabs, the prompt template
    (menu 13), bias, regex, module integration, separate parameters, and its
    own preset list.
  - `providers.additionalParams` (global, not a preset field) stays on the
    Model page.
- `botpreset.svelte` takes a kind (`model` | `prompt`), or a sibling list
  component is added for model presets. Ctrl+1..9 and `presetChain` stay on
  prompt presets.

## Import / export

- `.risup` stays the prompt preset format. `downloadPreset` writes prompt
  fields only; upstream readers fill missing model fields from their template.
- `importPreset` keeps prompt fields, ignores the model fields and `proxyKey`.
  NovelAI and SillyTavern conversion stay.
- Model presets get no file format in this plan (they hold endpoints).

## Later: per-chat selection

Out of scope, but the contracts above are its seam: a chat gains optional
`modelPresetId`/`promptPresetId`, and the client picks the chat's ids when set,
else the tab selection. The server already takes explicit ids, so it does not
change.

## Slices

1. Shared schema: field partition + test, the model preset normalizer, the
   `modelPresets` resource kind, the `llmSecrets.modelPresets` map, retire
   the keep-on-switch fields from `providers`.
2. Server: two-id contracts, the shared merge helper, `jobScope`/
   `loadRequestDb`, `presetChain` without keep rules, `proxyKey` by model id.
3. Client storage: `selection.modelPresetId`, `activeModelPreset`, root
   routing, model preset actions, both ids on every request.
4. UI: the two settings pages and the preset lists.
5. Import/export: prompt-only `.risup`.
   Landed early with slice 3 (forced by the schema split): the prompt-only
   `downloadPreset` allowlist, imports ignoring `proxyKey`, and the
   SillyTavern instruct conversion saving its chat format as a separate,
   unselected model preset.
6. Docs: `docs/structure/persistence.md`, `settings-i18n.md`,
   `llm-requests.md`, `chat-pipeline.md`, and `STRUCTURE.md` anchors.

Each slice runs `pnpm check`, `pnpm test`, and the touched tests listed in the
guides (preset tests live in `src/ts/storage/tests/preset*.test.ts`; the
`FORWARDED_ROOT_KEYS` count in `presetSchema.test.ts` changes on purpose).
