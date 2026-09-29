# Slice: Forwarding Layer For Presets, And The Per-Client Selection

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 3](../../phase-3-settings-sections.md), "Remove the working copies" (presets),
"Field map", "Keep-on-switch settings", "Ids" (the client preset paths, the `botPresetsId === -1`
branch), and "Selection state" (`botPresetsId`, `loreBookPage`); `PLAN.md` Decision 3.

Depends on: slice 1 (verdict) and slice 4 (sections mirrored; the residual `root` holds the
preset working copy, the persona working copy, and the three selection indexes). After this
slice the residual `root` holds only the four persona fields and `selectedPersona`.

## Scope

Allowed files: `src/ts/storage/forwarding.svelte.ts` (new: the layer, from the spike harness),
`src/ts/storage/selection.svelte.ts` (new: the per-client selection store; `personaId` is added
by slice 6), `src/ts/storage/database.svelte.ts` (`setDatabaseLite` installs the layer;
`saveCurrentPreset`, `changeToPreset`, `setPreset` shrink to the keep-on-switch copies;
`copyPreset`, `downloadPreset`, `importPreset` by id; `getDatabase` unchanged),
`src/ts/storage/resourceSync.svelte.ts` (the residual root projection loses the preset keys,
`botPresetsId`, and `loreBookPage`), `src/ts/bootstrap.ts` (`assembleDatabase` no longer sets
`botPresetsId`; `loadData` calls `loadSelection`), `src/ts/setting/utils.ts` and
`src/lib/Setting/Wrappers/Setting{Check,Number,Text,Textarea,Select,Slider,Color}.svelte` (Astra
P2: synchronous writes), `src/lib/Setting/botpreset.svelte`, `src/lib/Setting/Pages/BotSettings.svelte`
(the preset `image` write and name display; the image handler captures the id before its
`await`), `src/ts/hotkey.ts`, `src/ts/process/index.svelte.ts` (`presetChain`),
`src/ts/process/prompt.ts` (`promptConvertion` keeps its ids from slice 2; only the push target),
`src/lib/Others/WelcomeRisu.svelte` (`setPreset` on the live db), `src/lib/SideBars/LoreBook/LoreBookList.svelte`,
`src/lib/Setting/lorepreset.svelte`, `src/lib/Setting/Pages/GlobalLoreBookSettings.svelte`
(`loreBookPage`), `src/ts/plugins/apiV3/v3.svelte.ts` (verify only), `src/lang/en.ts` if a
notice is needed. Tests belong to the review step.

Identifiers (verified): the 77 root fields `setPreset` assigns; `botPresetsId` writers
`bootstrap.ts` (`assembleDatabase`) and `botpreset.svelte` (`movePreset`); `botPresets`
mutators `botpreset.svelte` (reorder, delete, the "new preset" push of `prebuiltPresets.OAI2`,
`bind:value` on `botPresets[i].name`), `BotSettings.svelte:1074` (`image`), `prompt.ts`
(`promptConvertion`, two pushes); `changeToPreset` callers `botpreset.svelte`, `hotkey.ts`,
`index.svelte.ts` (`presetChain`, matching by `name`); `setPreset` caller `WelcomeRisu.svelte`;
`importPreset` callers `App.svelte`, `characterCards.ts` (`characterURLImport`),
`botpreset.svelte`; `getSettingValue`/`setSettingValue` (`utils.ts`, plain property access);
`SettingSegmented.svelte` (`bind:value={DBState.db[item.bindKey]}`, already synchronous);
`allowedDbKeys` (`temperature`, `maxContext`, `maxResponse`, `frequencyPenalty`,
`PresensePenalty`, `moduleIntergration`, `seperateModels`, `seperateModelsForAxModels`);
`normalizePromptTemplate` callers (`setDatabase`, `saveCurrentPreset`, `setPreset`,
`importPreset`: all pass proxied arrays today).

Stopping condition: a `bind:` site or a reader the accessor cannot serve (a fallback trigger),
or a reader of `botPresetsId` that needs the index persisted and shared (none found: every
reader indexes the local array).

## Assumptions

- Slice 1 passed its proofs (otherwise the fallback form below applies), including proof 4: the
  wrapper effect pattern misroutes an edit made in the same flush as a switch, and a function
  binding that writes synchronously does not.
- `installForwarding` runs on the raw object in `setDatabaseLite` before `DBState.db = data`;
  `setPluginDatabaseLite`, `setPluginDatabase`, `importPlugin`, and `WelcomeRisu.svelte` pass the
  live proxy back, so the idempotent install (descriptor check) covers them, and the layer never
  `defineProperty`s through the proxy.
- After slice 4 no code enumerates root keys generically: the residual root projection, its
  watcher, and its `applyToMirror` branch use `RESIDUAL_ROOT_KEYS`, which this slice shrinks to
  the persona keys and `selectedPersona`. No path deletes a forwarded key.
- The deep `presets` watcher (Phase 1) saves a forwarded write; `llmSecretPresets` (slice 4)
  holds the per-preset `proxyKey`.
- Every preset has an id (slice 2 assigns at creation, slice 3 backstops), so selection by id
  is total; `PRESET_ROOT_ALIASES` and `PRESET_FIELDS` come from `shared/presets.ts`.

## Proposed decisions

- Forwarded set (decided by the phase file; count from the tree): `FORWARDED_PRESET_KEYS` = the
  77 `setPreset` targets minus the five keep-on-switch fields minus `autoSuggestPrefix` and
  `autoSuggestClean` (Opus P5: `saveCurrentPreset` never writes them, so they are global today;
  they become `ui` fields in slice 2's taxonomy and leave `PRESET_FIELDS`, recorded) = 70 keys,
  plus `proxyKey`, whose accessor reads and writes `llmSecretPresets[selectedId].proxyKey`
  (creating the entry on write). `name` and `image` are not forwarded.
- Resolution on every access (Astra P3): the getter and the setter resolve
  `DBState.db.botPresets.find(p => p.id === selection.presetId)` each time, through the proxy,
  so a collection replaced by a conflict reload or a plugin setter is honored; a missing
  selection falls back to the first record and, on the setter, re-selects it. No object is
  cached.
- Selection store (decided by the plan: per-client ids, `localStorage`; shape proposed):
  `selection.svelte.ts` exports `selection` (`$state` `{ presetId, loreBookPage }`, `personaId`
  added in slice 6), `selectPreset(id)`, `loadSelection()` (reads `localStorage` key
  `risu-selection` after the collections are in the mirror; an unknown id falls back to the
  first record, an out-of-range `loreBookPage` to 0), saved on every change, and
  `reconcileSelection()` called by `applyToMirror` after a collection replacement or removal
  (Astra P3). `DBState.db.botPresetsId` and `loreBookPage` become accessors installed by
  `installForwarding` (`botPresetsId` getter: the index of the selected id or 0; setter: selects
  the id at that index), so the index readers (`botpreset.svelte`, `BotSettings.svelte`,
  `CustomSidebar.svelte`, hotkeys) keep working until Phase 6's `aggregate-removal` deletes
  `forwarding.svelte.ts` whole (the accessors, the shims, and the Phase 6 facade).
- Synchronous settings wrappers (Astra P2): the seven wrappers replace the `localValue` plus
  two-`$effect` pattern with a function binding, `bind:value={() => getSettingValue(item, ctx),
(v) => setSettingValue(item, v, ctx)}` (Svelte 5 function bindings; `SettingSegmented` already
  binds the DB directly), so a write goes through the accessor in the same task as the user's
  input and captures the selected id then. `setSettingValue` is unchanged (plain property
  assignment). Asynchronous writers capture the id before their first `await`: the preset
  `image` handler in `BotSettings.svelte` (`const id = selection.presetId` before reading the
  file), `promptConvertion` (pushes new records, no selection), and slice 6 does the same for
  `selectUserImg`.
- Switching (decided by the plan: keep-on-switch stays on today's path): `changeToPreset(id:
string)` (1) copies the five keep-on-switch `providers` fields into the current preset exactly
  as `saveCurrentPreset` does (`seperateModels: doNotChangeSeperateModels ? null : clone`, ...),
  (2) `selectPreset(id)`, (3) copies the new preset's five fields into `providers` exactly as
  `setPreset` does, honoring the three toggles. `setPreset` and `saveCurrentPreset` shrink to
  those copies (names kept); the `botPresetsId === -1` branch goes. `hotkey.ts` maps its 1-9
  index to `botPresets[index].id`; `presetChain` maps the matched `name` to its id;
  `botpreset.svelte` reorders without touching the selection; `downloadPreset` strips `id` and
  still blanks the credentials; `WelcomeRisu.svelte` applies `prebuiltPresets.OAI2` onto the
  selected preset by id (through `normalizePreset`, keeping the id).
- Snapshot at the client boundary (Astra P7): every client caller of `normalizePreset`,
  `normalizePresets`, and `normalizePromptTemplate` passes `$state.snapshot(...)` of a proxied
  value; the shared functions receive plain data only (their own clone is a plain recursive JSON
  clone). The plugin `setDatabase` path is covered because `setDatabase` no longer normalizes
  preset fields.
- Missing-field behavior change (decided by the plan; recorded by slice 7): the accessor
  returns the normalizer default when the selected preset lacks a field; nothing is inherited.
- Fallback form (if slice 1 fails): `src/ts/storage/selected.svelte.ts` exports `SelectedPreset`
  (a `$state` projection rebuilt on selection change; each field's setter writes synchronously
  into the record by id, never from an `$effect`), the 144 preset `bind:` sites in
  `BotSettings.svelte` (59), `OobaSettings.svelte` (43), `PromptSettings.svelte` (22),
  `EasyPanel.svelte` (11), `AuxModelSelectors.svelte` (5), `OpenrouterSettings.svelte` (4),
  `SeparateParametersSection.svelte` (2), `CustomSidebar.svelte` (1) minus the keep-on-switch
  binds, the 43 direct assignments (`WelcomeRisu.svelte` 17, `BotSettings.svelte` 11,
  `PromptSettings.svelte` 5, `OobaSettings.svelte` 4, `EasyPanel.svelte` 2,
  `PluginSettings.svelte` 1, two parser tests), the declarative `bindKey` items of
  `botSettingsParamsData.ts` (a `bindTarget: "preset"` flag read by `getSettingValue`/`setSettingValue`),
  and the process-layer readers of the preset fields (`src/ts/process/**`, `src/ts/tokenizer.ts`,
  `src/ts/cbs.ts`) move to it; Phase 4's `updateSettings` and `readSetting` (its
  `plugin-host-setters` slice) carry the mapping of the forwarded keys of `allowedDbKeys` to the
  projection, so the plugin setters need no change of their own. The allowed files then extend
  to those.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Manual, in headless Chrome
against a fresh server, recorded here: edit a preset field on each of the eight preset binding
pages, switch presets, reload: the edit is in the original preset and the other unchanged; edit
a declarative parameter and switch in the same interaction (keyboard shortcut for the switch
while the input has focus): same result; two tabs with different selections: a preset edit in
one does not change the other's selected preset, apart from the five keep-on-switch fields
(Opus P7); hotkeys 1-3 and a `presetChain` send switch by id; plugin `setDatabase({ temperature })`
lands in the selected preset; a conflict reload of `presets` followed by an edit without a
switch lands in the reloaded record. Review-step tests: the layer over the real module graph
(install, idempotence, get, set by captured id, resolution after collection replacement,
fallback after removal, snapshot, ownKeys), the selection store (fallbacks, `localStorage` round
trip, `reconcileSelection`), the wrappers' synchronous write (the spike's proof 4 as a
regression test), and `changeToPreset` honoring the three toggles.

## Residual risk

The five keep-on-switch fields and their three toggles stay `providers` fields that
`changeToPreset` copies, so two clients with different selections still overwrite each other's
`seperateModels`, `seperateModelsForAxModels`, `fallbackModels`, `fallbackWhenBlankResponse`, and
`seperateParameters` (accepted by Decision 3; slice 7 records it and the two-tab check excepts
them). Selection is per tab and not synchronized live. `presetChain` still switches the client's
selection on every send until Phase 5. Presets remain one collection resource (the Phase 1 status
quo), so two clients editing different presets conflict at the collection revision and one
reloads. The persona working copy and `selectedPersona` are still root fields until slice 6.
