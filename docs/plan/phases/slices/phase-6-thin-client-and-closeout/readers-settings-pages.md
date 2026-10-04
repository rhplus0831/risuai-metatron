# Slice: Readers, Settings Pages

Status: implemented 2026-10-05 (Phase 6 slice 6; "Implementation notes" below).

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Projections" (`OtherBotSettings.svelte`
and `BotSettings.svelte` of the named top consumers; "components bind to these instead of
`DBState.db`") and the Safety Contract measurement (the reference counts drop per file group);
`PLAN.md` invariant 3 and Decision 3 (readers use the selected-id projections).

Depends on: `settings-ownership` (the records, the facade). Parallel with
`readers-settings-consumers` and `readers-characters`: the accessors keep every unmigrated
reader working, so file groups migrate independently (Opus P1, P9).

## Scope

Allowed files: every file under `src/lib/Setting/**` with a `DBState.db` reference (35 files,
841 matching lines today, led by `Pages/OtherBotSettings.svelte` 261, `Pages/BotSettings.svelte`
225, `Pages/OobaSettings.svelte` 56, `Pages/PromptSettings.svelte` 50, `Pages/PersonaSettings.svelte`
23, `botpreset.svelte` 23, `Pages/Advanced/CustomModelsSettings.svelte` 22,
`Pages/Language/TranslatorPresetSettings.svelte` 22, `Pages/Module/ModuleSettings.svelte` 22,
`Pages/OpenrouterSettings.svelte` 22, `Pages/PluginSettings.svelte` 17,
`Pages/Module/ModuleChatMenu.svelte` 16, `lorepreset.svelte` 10), the wrappers
`src/lib/Setting/Wrappers/*.svelte`, `src/lib/Setting/SettingRenderer.svelte`, the registry
`src/ts/setting/{utils,types}.ts` and the six data files, `src/lang/en.ts`. Not here: the
character creation in `ModuleSettings.svelte:87-90` (Phase 4's allowlist; `readers-characters`,
same file edited twice is accepted because the two slices touch different functions and the
second runs after the first). Tests belong to the review step.

Identifiers (verified 2026-09-30; matching lines, tests excluded): the counts above (`rg -c 'DBState\.db'`);
the 394 `bind:` sites' preset-owned family (147) and other-settings family (159) and their
files (the spike lists them); the registry pages (`AccessibilitySettings`, `AdvancedSettings`,
`ChatFormatSettings`, `LanguageSettings` pure; `BotSettings` and `DisplaySettings` hybrid), the
12 registry-mounted custom components (`src/ts/setting/customComponents.ts:18-47`), the 15
hand-written pages; `getSettingValue`/`setSettingValue` (`utils.ts:30-64`), the 155 `bindKey`
items, the 8 `getValue`/`setValue` item pairs (`displaySettingsData.svelte.ts:417-454`),
`SettingSegmented.svelte:53`, `SettingRenderer.svelte:20-28` (`ctx.db: DBState.db`,
`$derived` on `aiModel` and `subModel`); the reactive readers `BotSettings.svelte:54-140`
(`nanogpt*`, `aiModel`, `subModel`, `textgenWebUIStreamURL` effects), `NullableTextColorToggle.svelte:13`
(`DBState.db[field]`); Phase 4's allowlist entries in this group: `PersonaSettings.svelte:50, 115-120, 196-197`,
`botpreset.svelte:62, 290-291, 340-342`, `lorepreset.svelte:52-53, 76-78`, `PluginSettings.svelte:119-120`,
`CustomModelsSettings.svelte:67, 82, 93-94, 206-216`, `TranslatorPresetSettings.svelte:53-54, 79, 103-104, 149-150`,
`OtherBotSettings.svelte:1171-1172, 1196, 1219-1220, 1278-1279`, `ModuleSettings.svelte:110-117, 170-178, 203, 240`
(the collection pushes and reorders), the settings wrappers (`setting/*.svelte.ts`).

Stopping condition: a binding whose shape the spike's pattern cannot serve (reported), or a
page that reads a field no record holds (a dropped field; reported, not re-added).

## Assumptions

- `settings-ownership` landed: `settings.<kind>` records, `selectedPreset` and `selectedPersona`
  resolved through Phase 3's selection, `applyPresetTemplate`, the facade on `DBState.db`.
- Phase 3's synchronous function-binding wrappers are in place (an edit and a switch in one
  flush do not misroute).
- The spike's verdict names the pattern; under the fallback every `bind:` here becomes a
  function binding calling `updateSettings` or the collection setter.

## Proposed decisions

- Bindings (proposed): each `bind:` and each direct assignment binds or writes
  `settings.<section>.<field>`, `selectedPreset.<presetField>` (the preset's own names:
  `NAISettings`, `reasonEffort`, `regex`; the 147 preset sites change their key names, which
  `pnpm check` lists because the preset type carries the preset names), `selectedPersona.<field>`,
  or a collection record (`settings.personas`, `settings.customModels`, `settings.loreBook`,
  `settings.translatorPresets.items`, `settings.hypaV3Presets.items`, `settings.presets`,
  `settings.plugins`, `settings.modules`). The allowlist writers in this group call the Phase 4
  setters (`setPersonas`, `addPersona`, `upsertPlugin`, `setModules`, `addModule`, ...) or write
  through the record.
- Registry (proposed): `SettingContext.db` becomes `settings` (the namespace) plus
  `selectedPreset`; `getSettingValue`/`setSettingValue` map a `bindKey` to its record through a
  reverse map of `SECTION_FIELDS` (built once) or to `selectedPreset` for `bindTarget: "preset"`
  (Phase 3's fallback design, now the only design); `bindPath` keeps working relative to the
  record; the 8 item-level `getValue`/`setValue` functions and the condition functions receive
  `ctx.settings` instead of `ctx.db` (Opus P14). `SettingSegmented.svelte` binds through the
  same resolver.
- `WelcomeRisu.svelte` is `readers-settings-consumers`' (it is under `src/lib/Others`).

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Review-step tests: a component
test per registry page (`guiRendering.test.ts` precedent) that binds and writes; a type-level
test that every `bindKey` and preset key is in `SECTION_FIELDS` or `PRESET_FIELDS`; the item
functions over `ctx.settings`. Manual, recorded here: every settings page loads, edits save and
survive a reload; the preset pages edit the selected preset and a switch lands the edit in the
original. Scoped gate: `rg -c 'DBState\.db' src/lib/Setting src/ts/setting` returns nothing.

## Residual risk

Two slices edit `ModuleSettings.svelte` (different functions, sequential). The Display pages'
`NullableTextColorToggle` reads a dynamic field name; the resolver covers it because every field
name is in `SECTION_FIELDS`.

## Implementation notes (2026-10-05)

How the implementation departs from the proposed decisions above, after the plan review (Astra,
segment C):

- **The views** live in `src/ts/storage/settingsViews.svelte.ts`: `settings.<section>.<field>`,
  `settings.<collection>` (`translatorPresets`/`hypaV3Presets` as `{ items, selectedId }`;
  `settings.presets`, `modules`, `plugins`, `pluginStorage`), `activePreset.<presetField>`, and
  `activePersona.<field>`. The spec's `selectedPreset`/`selectedPersona` are named `activePreset`/
  `activePersona`, because `selectedPreset(db)`/`selectedPersona(db)` are the forwarding layer's existing
  resolver functions (used outside this slice). The views reuse those functions over the records (a
  records-backed stand-in for the database), so the facade and the views resolve the selection the same
  way; the facade's accessors are unchanged. Every getter looks its record up when it runs; every setter
  runs untracked and resolves only the record the selection names (a write with none is dropped, never
  redirected). A missing preset value reads as a fresh copy of its default (`presetFieldValue`), so a
  change inside it saves nothing, as through the facade. `activePreset` serves every preset field but the
  keep-on-switch group (those are `settings.providers` fields) and not `proxyKey` (the facade's,
  `SecretInput` edits it). A handler that awaits captures `activePreset.id`; `currentPresetRecord()`/
  `currentPersonaRecord()` return the record itself, or `undefined`, where a raw record is needed (the
  preset card's `name`/`image`, the persona delete).
- **The registry.** `SettingContext` is `{ settings, preset, persona, modelInfo, subModelInfo }`;
  `getValue(ctx)`/`setValue(value, ctx)`. `bindKey` is typed `SettingsRootKey` (the root names the views
  serve: section fields, forwarded preset keys, persona aliases, collection roots), so `pnpm check` is the
  type-level test that every key is served; `readSettingsRoot`/`writeSettingsRoot` resolve a key or
  `bindPath`'s first segment (typed `${SettingsRootKey}.${string}`) and refuse any other name.
  `SettingSegmented` binds through `getSettingValue`/`updateSettingValue` like the other wrappers (it
  bound its `bindKey` on `DBState.db` directly; no segmented item has an `onChange` or a getter).
- **Selection reads.** The preset and persona lists derive the selected id once per render
  (`activePreset.id`, `activePersona.id`) instead of reading the selected index (a search of the list) for
  every row; `loreBookPage` is `selectedLoreBookPage()`/`selectLoreBookPage()`.
- **Helpers** taking a root-shaped state get a narrow object (`selectedHypaV3Preset`,
  `getCurrentTranslatorPresetFromState`, `templateCheck`, `activeHotkeys` with `settings.ui`).
- **`PromptSettings`** reads the template through `activePreset.promptTemplate ?? []` (it threw on a preset
  without one); nothing is written on mount.
- **Left on `DBState.db`:** the character reads of `Pages/Module/ModuleChatMenu.svelte` and
  `OtherBotSettings.svelte` (`readers-characters`). `SettingsExportButtons.svelte`'s `statics` read moved;
  its export is a snapshot of `getDatabase()` (slice 10).
- **After the challenge** (Astra, 2026-10-05): the large-portrait checkbox writes the persona the
  selection resolves to (`currentPersonaRecord()`, the first persona when the selection names none), as
  its index binding did, instead of `activePersona`'s setter (which drops a write with no selected
  persona); `SettingsRootKey` derives the forwarded root names from the preset fields and aliases
  (`FORWARDED_PRESET_KEYS` is typed `keyof Database`, which admitted every key), and `bindPath` is typed by
  its root; `SettingSegmented` binds through the registry like the other wrappers.
- **Not changed:** the first visit to some settings pages still saves the defaults their controls fill in
  on mount (the baseline does the same, measured at slice 4).

### Measurements (the preset-reorder criterion carried from slice 4)

`util/playwright/measureRecords.mjs`, production builds, headless Chrome, the baseline `35678fd4` (the
commit before slice 4) measured alongside on the same machine; task-latency medians of 10, two runs each:

| Workload                              | Baseline (`35678fd4`) | Slice 4 (recorded) | This slice |
| ------------------------------------- | --------------------- | ------------------ | ---------- |
| NovelAI image settings mount          | 4.7–5.1 ms            | 4.6–4.7 ms         | 4.7–4.8 ms |
| A keystroke into `NAIImgConfig.width` | 9.2–10.4 ms           | 9.8–10 ms          | 9.2–9.5 ms |
| Preset reorder, 50 presets            | 15.9–16.0 ms          | 22.2–24.4 ms       | 17.9 ms    |

The preset reorder is back from about +45% to about +12% (the rows compare each preset's id with the
selected id derived once, instead of reading the selected index, a search of the list, for every row).
The criterion (within 10% of the baseline: 17.5–17.6 ms against today's baseline) is **missed by about
2%**. Keyed rows (`(preset.id)`) were tried and were slower (18.4–20.1 ms); the remaining cost is the rows
reading each preset through its record wrapper after the reorder. A plain-row projection (each row's
`id`, `name`, `image` read once) could reduce the repeated wrapper reads but not remove them; it was not
measured. Removing them needs a tracked raw read of the record for display, which departs from owner
decision 1's wrapper reads; not done. (The module lorebook
drag moves in `readers-characters`, which owns `LoreBookList.svelte`.)
