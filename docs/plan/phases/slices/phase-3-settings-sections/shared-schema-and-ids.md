# Slice: Shared Schema, Taxonomy, And Client-Assigned Ids

Status: implemented 2026-09-30 (see "Implementation record" at the end).

Phase: [Phase 3](../../phase-3-settings-sections.md), "Sections" (the taxonomy), "Field map",
"Ids" (presets, personas, `translatorPresetId`, `hypaV3PresetId`), and the field lists of
"Secrets"; `PLAN.md` Decisions 3 and 6 and invariant 2 (Phase 2's precedent: the client assigns
ids optimistically, the server keeps them).

Depends on: step 0 (the pre-phase boot snapshot, from which the preset defaults are taken).
Parallel with slice 1. Slice 3 builds the server kinds from this slice's modules.

## Scope

Allowed files: `shared/sections.ts` (new), `shared/presets.ts` (new), `shared/presetTemplates.ts`
(new; the data of `src/ts/process/templates/templates.ts` and the strings of
`src/ts/storage/defaultPrompts.ts`), `shared/hotkeys.ts`, `shared/colorScheme.ts`,
`shared/translatorPresets.ts`, `shared/hypaV3Presets.ts`, `shared/chatLoadPages.ts` (new; the
pure defaults moved out of `src/ts/defaulthotkeys.ts`, `src/ts/gui/colorscheme.ts`,
`src/ts/translator/presets.ts`, `src/ts/process/memory/hypav3.ts`, `src/ts/chatLoadPages.ts`,
which re-export them), `shared/database.ts` (`botPreset.id`, `RisuPersona.id` required;
`autoSuggestPrefix`/`autoSuggestClean` leave `botPreset`), `shared/settings.ts`
(`TranslatorPreset.id`), `shared/memory.ts` (`HypaV3Preset.id`), `shared/resources.ts` (the kind
names and payload types for the five sections and twelve collections, used by slice 3), and
every client creation site of the four id-bearing collections (the list under Identifiers):
`src/ts/storage/database.svelte.ts`, `src/ts/bootstrap.ts`, `src/ts/process/prompt.ts`,
`src/lib/Setting/botpreset.svelte`, `src/ts/persona.ts`, `src/lib/Setting/Pages/PersonaSettings.svelte`,
`src/ts/interchangeability.ts`, `src/ts/translator/presets.ts`,
`src/lib/Setting/Pages/Language/TranslatorPresetSettings.svelte`, `src/ts/process/memory/hypav3.ts`,
`src/lib/Setting/Pages/OtherBotSettings.svelte`, `src/ts/plugins/apiV3/v3.svelte.ts` (an
`ensureIds` pass for `personas` in both setters), `src/ts/storage/exportAsDataset.ts` only if it
copies presets. Tests belong to the review step.

Identifiers (verified; creation sites from Luna fan-out 3, read back): presets: `presetTemplate`
(`database.svelte.ts:875`), `prebuiltPresets.NAI|OAI|OAI2` (`templates.ts`), `setDatabase`'s
default array (`:187`), `saveCurrentPreset`'s rebuilt literal (`:941`, pushed or assigned at
`:1027-1031`: it must carry the existing id until slice 5 deletes it), `copyPreset` (`:1040`),
`importPreset` (`:1247`, `:1252`, the NAI path `:1261-1279`, the ST path `:1285-1383`, the
generic push `:1390`), `assembleDatabase` (`bootstrap.ts:133`), `promptConvertion`
(`prompt.ts:226`, pushes at `:356`, `:437`), the new-preset button (`botpreset.svelte:338-342`,
clones `prebuiltPresets.OAI2`); personas: `setDatabase`'s default (`database.svelte.ts:395`),
`checkNewFormat` (`bootstrap.ts:332`, the boot repair), `importUserPersona` (`persona.ts:126`),
the create-from-scratch push (`PersonaSettings.svelte:115`), `convertCharacterToPersona` and
`convertModuleToPersona` (`interchangeability.ts:136`, `:176`), plugin `setPluginDatabase` and
`setPluginDatabaseLite` (`v3.svelte.ts:873`, `:898`, `personas` in `allowedDbKeys`); translator
presets: `createTranslatorPreset` (`translator/presets.ts:91`), `getDefaultTranslatorPreset`
(`:68`), `normalizeTranslatorPresetState` (`:108`, recreates every element), the `.risutl`
decoder (`:200`), the new/rename/import handlers (`TranslatorPresetSettings.svelte:51-56`, `:79`,
`:146-152`); HypaV3 presets: `createHypaV3Preset` (`hypav3.ts:1591`), `setDatabase` (`:623`,
`:630` recreates every element), the new/rename/import handlers (`OtherBotSettings.svelte:1168-1172`,
`:1196`, `:1272-1279`). Reorder and delete sites keep elements and need no id work.

Stopping condition: a creation site that cannot obtain an id without an `await` before the
insert (none: `crypto.randomUUID()` is synchronous), or a shared module that cannot pass the
strict server compiler without a client import (then the value is split further).

## Assumptions

- Step 0's `boot-snapshot.json` exists; its root values are the effective pre-phase defaults
  (Astra P8, Opus P3: `setDatabase` root defaults differ from `presetTemplate` for `maxResponse`
  500 vs 300 and the two textgen URLs, and `checkNewFormat` raises `loreBookToken` to 8000).
- `globalThis.crypto.randomUUID()` exists in Node 24 and in the browser's secure context; shared
  code uses it (no package imports in `shared/`).
- `defaultHotkeys` and `chatLoadPages.ts` are portable as-is; `defaultColorScheme`,
  `createHypaV3Preset`, `createTranslatorPreset`, `normalizeTranslatorPresetState`,
  `prebuiltPresets`, `prebuiltNAIpresets`, and the prompt strings are pure but live in modules
  that import Svelte, the DOM, or client code, so they are split out (checked per module).
- `saveCurrentPreset` (until slice 5 deletes it) and `normalizeTranslatorPresetState` and the
  HypaV3 `setDatabase` loop (until slice 4 removes them from the client) recreate elements; this
  slice makes each carry the existing id through, so no client path drops an id after it lands.
- `forceReplaceUrl2` has no reader (Luna fan-out 3: type, template, prebuilt values, and the
  exporter's blanking only), and `autoSuggestPrefix`/`autoSuggestClean` are never written by
  `saveCurrentPreset` (Opus P5).

## Proposed decisions

- `shared/sections.ts` (decided by the phase file; shape proposed): `SECTION_KIND` (`providers`,
  `secrets`, `llmSecrets`, `ui`, `memoryTranslateMedia`), `SECTION_FIELDS` (one `as const` array
  of `Database` keys per section, from the report's taxonomy with the review corrections:
  `supaMemoryKey` in `llmSecrets`, `autoSuggestPrefix` and `autoSuggestClean` in `ui`,
  `hypaMemoryKey` dropped), `COLLECTION_KIND` (the twelve collection kinds and the `Database`
  field or field pair each holds), `RESIDUAL_ROOT_KEYS` (the 77 `setPreset` targets, the four
  persona fields, `botPresetsId`, `selectedPersona`, `loreBookPage`; slices 5 and 6 shrink it to
  empty), `FORWARDED_PRESET_KEYS` (70 keys: the 77 minus the five keep-on-switch fields minus the
  two auto-suggest fields), `DROPPED_FIELDS`, and a type-level test that these sets, the Phase 1
  fields (`characters`, `botPresets`, `modules`, `plugins`, `pluginCustomStorage`), and both
  fields of each `{ items, selectedId }` pair partition `keyof Database`.
- `shared/presets.ts` (decided by the plan; content proposed): `PRESET_FIELDS` (the canonical
  list: the 77 `setPreset` targets plus `name` and `image`, minus `autoSuggestPrefix`,
  `autoSuggestClean`, `forceReplaceUrl2`, and `openAIKey`; `proxyKey` stays until slice 7: 77
  keys now, 76 after slice 7), each with its default taken from the pre-phase boot snapshot
  (the `setDatabase` root default as a fresh boot shows it, not `presetTemplate`'s value: Opus P3),
  `PRESET_ROOT_ALIASES` (`NAIsettings`↔`NAISettings`, `reasoningEffort`↔`reasonEffort`,
  `presetRegex`↔`regex`), `PERSONA_ROOT_ALIASES` (`username`↔`name`, `userIcon`↔`icon`,
  `userNote`↔`note`, `personaPrompt`↔`personaPrompt`: Opus P9), `PRESET_KEEP_ON_SWITCH_FIELDS`,
  `presetTemplate` (kept as the `importPreset` base, unchanged values, plus `id` assignment at
  use), `defaultOoba`, `defaultAIN`, `normalizePromptTemplate` (moved; clones with a plain
  recursive JSON clone, never `structuredClone`: Astra P7), `normalizePreset(input, { id? })`
  (pure: keeps only canonical keys, fills each missing one with its default, applies the preset
  migrations that `setDatabase` and `setPreset` apply to the root copy today: `NAIsettings.starter`,
  `cfg_scale`, `mirostat_tau`, `mirostat_lr`; `promptSettings.maxThoughtTagDepth`; the
  `formatingOrder` insertion of `"personaPrompt"`; the `top_p` non-number fix; the
  `localNetworkMode`/`localNetworkTimeoutSec` coercion; `seperateParameters.overrides`; the
  `fallbackModels` empty-string filter; the `customAPIFormat` default; `openrouterProvider`
  string to object (Opus P4); keeps a valid `id` or assigns one), `normalizePresets(input)` (a
  non-array or empty input yields `[normalizePreset({ name: "New Preset" })]`, duplicate ids are
  re-keyed), `newPresetId()`. The client imports the same module for the forwarding layer and
  the importers, so the field map is written once.
- Ids at creation (Opus P1a, Astra P1, Astra P9): every site under Identifiers assigns an id
  synchronously before the element enters its array: `normalizePreset` at each preset site (the
  template, the prebuilt presets, `promptConvertion`, the new-preset button, `copyPreset` with a
  fresh id, `importPreset` on every path with a fresh id even when the file carries one),
  `newPersonaId()` at the four persona sites and `ensureIds` in the plugin setters (a plugin
  array element without an id gets one; an existing id is kept; Phase 4's `setPersonas` in its
  `plugin-host-setters` slice takes this over and the pass is deleted then, with no change to
  Phase 3's order), `createTranslatorPreset` and
  `createHypaV3Preset` assign ids (their normalizers keep existing ones), the `.risutl` decoder
  and the HypaV3 JSON importer assign fresh ids, and `saveCurrentPreset` carries the current id
  into its rebuilt literal until slice 5 deletes the function. `checkNewFormat`'s persona repair
  stays until slice 6 (harmless). `downloadPreset` and the `.risutl` encoder strip `id` (the
  encoder already rebuilds `{ name, prompt, maxResponse }`, verified); the HypaV3 JSON export is
  changed in slice 4.
- `RisuPersona.id`, `botPreset.id`, `TranslatorPreset.id`, `HypaV3Preset.id` become required in
  the shared types in this slice, together with every constructor, so `pnpm check` lists any
  site the list above missed (Astra P9).
- Credentials in preset objects (decided by the plan): `openAIKey` leaves `PRESET_FIELDS` now
  (never restored, always blanked on export); `proxyKey` stays until slice 7.

## Validation

`pnpm check` (the strict server project compiles the new `shared/` modules; the required ids
surface every constructor), `pnpm test`, `pnpm format:check`, `server/src/tests/sharedImports.test.ts`
(plain `node` imports every `shared/*.ts`). Review-step tests: `normalizePreset({})` equals the
boot-snapshot defaults plus an id; each listed migration; extra keys dropped; the aliases; a
`.risup` decoded by `importPreset` then normalized equals the fixture preset plus an id;
`normalizePresets([])` yields one default; duplicate ids re-keyed; the input never mutated; the
partition test; each creation site produces an element with an id (component tests for the
three settings pages, unit tests for the rest).

## Residual risk

Until slice 3 the server keeps its identity normalizers, so ids are persisted exactly as the
client sends them (which is the intent). Until slice 5 the client still copies presets through
the root, so a preset missing a field still inherits the previous preset's value on switch (the
behavior change lands with slice 5). A plugin that hands `setDatabase` a preset-shaped object
cannot: `botPresets` is not in `allowedDbKeys`.

## Implementation record

Implemented by Claude Opus on 2026-09-30, following `implementation-plan.md` (amendments A1, A2,
A3, A6, A12, A18, F-f).

- New shared modules: `sections.ts` (the partition; checked at runtime: 376 `Database` keys, each
  in exactly one list; 69 forwarded preset keys; 77 residual root keys), `presets.ts`, `ids.ts`,
  `hypaV3Presets.ts`, `translatorPresets.ts`, `colorScheme.ts`; moved with `git mv`:
  `presetTemplates.ts` (was `src/ts/process/templates/templates.ts`, plus the default prompts of
  `src/ts/storage/defaultPrompts.ts`), `hotkeys.ts` (was `src/ts/defaulthotkeys.ts`),
  `chatLoadPages.ts`. The old client paths re-export them.
- `PRESET_DEFAULTS` equals the boot snapshot for every field the snapshot has; fields a fresh
  boot leaves unset take `setPreset`'s fallback (else `saveCurrentPreset`'s), and five with
  neither (`promptPreprocess`, `koboldURL`, `proxyRequestModel`, `promptTemplate`,
  `localStopStrings`) stay absent.
- Ids at creation: `normalizePreset` at the new-preset button, `copyPreset`, every
  `importPreset` path, `promptConvertion`, `assembleDatabase` (an empty list), and `setDatabase`
  (`normalizePresets` replaces the per-preset migration loop and backstops ids of records saved
  before); `newPersonaId` in `setDatabase`'s default, the create-from-scratch push, and both
  conversions in `interchangeability.ts` (`importUserPersona` already assigned one); a
  `withPersonaIds` pass in both plugin setters; `createTranslatorPreset` and `createHypaV3Preset`
  keep a valid id or assign one; the `.risutl` decoder and the HypaV3 JSON importer assign fresh
  ids.
- Exports: `downloadPreset` deletes `id` and still blanks the credentials; the `.risutl` encoder
  writes only `name`, `prompt`, `maxResponse`.

Deviations from this file:

- `newId` uses `crypto.getRandomValues`, not `crypto.randomUUID`: the latter needs a secure
  context, and the self-host client may be served over plain HTTP on a LAN address (the
  Assumption was false).
- The runtime `RESOURCE_KIND` entries wait for slice 3 (A1); this slice adds only the payload
  types (`SectionResource`, `LlmSecretsResource`, `CollectionResource`).
- `statics` is a thirteenth collection (F-f), not a `ui` field.
- `saveCurrentPreset` returns `normalizePreset(...)` with the current id (A12), so the text the
  client saves is the canonical form the server normalizer will produce; `openAIKey`,
  `forceReplaceUrl2`, and the auto-suggest fields leave preset objects now.
- The HypaV3 JSON export writes `{ name, settings }` in this slice instead of slice 4, because
  the id appears here.
- `koboldURL: null` and a prompt item's `innerFormat: null` were removed from
  `prebuiltPresets` (the strict server compiler rejects `null` for those optional strings;
  readers treat both the same as absent).
- `setPreset` takes `Omit<botPreset, "id">` (the welcome screen applies a template to the
  working copy).
- Null policy (after the Astra challenge): `normalizePreset` fills only absent or `undefined`
  fields and keeps an explicit `null` (`setPreset` passed `min_p`, `top_a`, and
  `repetition_penalty` through unchanged, and `saveCurrentPreset` writes `seperateModels: null`
  while `doNotChangeSeperateModels` is on). The five keep-on-switch fields are never filled; they
  stay on the pre-phase path, where `setPreset` applies their fallback.
- Behavior-change timing: because `setDatabase` runs `normalizePresets` on every load (and on
  every plugin `setDatabase` call, which now replaces `botPresets` with normalized copies that
  keep their ids and values), a stored preset missing a field gets the default from this slice
  on, so the "missing field inherits the previous preset's value" behavior ends here, not in
  slice 3 (F-d) or slice 5. `normalizePreset` fills defaults but does not validate shapes (a
  wrong-typed value passes through, as `setPreset` passed it before); slice 3 adds shape
  validation before the server uses it (Astra challenge, point 3).

Checks (after the null-policy fix): `pnpm check` (client and strict server), `pnpm format:check`,
`server/src/tests/sharedImports.test.ts`; `pnpm test` failed only in `translator/presets.test.ts`
(two cases that expected id-less presets and an id surviving a `.risutl` round trip, the contract
this slice changes), which the Fable test-adapter adapted. Decoded round trip in the page: each
fixture imported with `importPreset` and exported with `downloadPreset` decodes to the same preset
apart from `id`, and the export has no `id`. Playwright on a fresh server: ids on the preset, persona, translator, and
HypaV3 records, stable across a reload; the first boot saves once and a reload saves nothing;
copy, switch, edit, export (no `id`, blank `openAIKey`), and imports of `custom.risup` and of a
JSON preset that carries an existing id (both get fresh ids) behave as described.
