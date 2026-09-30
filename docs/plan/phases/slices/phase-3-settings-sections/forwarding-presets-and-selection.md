# Slice: Forwarding Layer For Presets, And The Per-Client Selection

Status: implemented 2026-09-30 (record below).

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

A preset copy, import, or delete that conflicts on only one of `presets` and `llmSecrets` reloads that record while the other change retries (a restored preset can lose its `proxyKey` entry, a copy can lack it); accepted with slice 7's multi-device risk. The five keep-on-switch fields and their three toggles stay `providers` fields that
`changeToPreset` copies, so two clients with different selections still overwrite each other's
`seperateModels`, `seperateModelsForAxModels`, `fallbackModels`, `fallbackWhenBlankResponse`, and
`seperateParameters` (accepted by Decision 3; slice 7 records it and the two-tab check excepts
them). Selection is per tab and not synchronized live. `presetChain` still switches the client's
selection on every send until Phase 5. Presets remain one collection resource (the Phase 1 status
quo), so two clients editing different presets conflict at the collection revision and one
reloads. The persona working copy and `selectedPersona` are still root fields until slice 6.

## Implementation record

Implemented on 2026-09-30 by Opus on `a6161c91`.

Files: `shared/sections.ts` (`RESIDUAL_ROOT_KEYS` = the four persona keys and `selectedPersona`;
new `CLIENT_SELECTION_KEYS` = `botPresetsId`, `loreBookPage`; new `FORWARDED_ROOT_KEYS` = the 69
`FORWARDED_PRESET_KEYS`, `proxyKey`, and the two client selection keys), `src/ts/storage/selection.svelte.ts`
(new), `src/ts/storage/forwarding.svelte.ts` (new), `src/ts/storage/database.svelte.ts`,
`src/ts/storage/llmSecrets.svelte.ts` (comment), `src/ts/bootstrap.ts` (`loadSelection` before the
assembly), `src/ts/setting/utils.ts` (`updateSettingValue`; `UNINITIALIZED` removed), the seven
wrappers, `src/lib/Setting/botpreset.svelte`, `src/lib/Setting/Pages/BotSettings.svelte`,
`src/lib/Others/WelcomeRisu.svelte`, `src/ts/hotkey.ts`, `src/ts/process/index.svelte.ts`, and the
docs (`STRUCTURE.md` D2, `persistence.md`, `settings-i18n.md`). `resourceSync.svelte.ts`,
`LoreBookList.svelte`, `lorepreset.svelte`, `GlobalLoreBookSettings.svelte`, `CustomSidebar.svelte`,
`prompt.ts`, and `v3.svelte.ts` needed no change: the root projection follows
`RESIDUAL_ROOT_KEYS`, and the index readers go through the `botPresetsId` and `loreBookPage`
accessors.

Decisions made while implementing, beyond the text above:

- Missing and `null` values (revised after the Astra challenge, points 3 and 4). The server kept
  an explicit `null` in any preset field (slice 2), while `setPreset` used to put a default (or the
  previous root value) in the root for most fields, and readers rely on it
  (`db.promptSettings.sendName`, `db.ooba.formating`). Now `normalizePreset` (server and client)
  replaces a `null` with the default except in `PRESET_NULLABLE_FIELDS` (new, `shared/presets.ts`:
  the ten fields whose `null` `setPreset` passed through: `promptTemplate`, `NAIadventure`,
  `NAIappendName`, `localStopStrings`, `repetition_penalty`, `min_p`, `top_a`,
  `openrouterProvider`, `thinkingTokens`, `dynamicOutput`) and the keep-on-switch fields. The
  getter never writes: a missing value reads as its `PRESET_DEFAULTS` value, a `null` in a
  non-nullable object or array field reads as a fresh default (a record between a local write and
  its normalization), and any other `null` reads as `null`, so a number input the user clears stays
  empty while editing. The server then stores the default, which the client shows after a reload,
  as the working copy did before Phase 3. `systemContentReplacement` `null` now becomes
  `"system: {{slot}}"` (the old `setPreset` gave `""`), and `JinjaTemplate` `""`. No inheritance
  from the previously selected preset remains.
- Reconciliation. There is no `reconcileSelection` call in `applyToMirror`: A15's lazy resolution
  covers conflict reloads, splices, and plugin replacements. `setDatabaseLite` resolves the
  selection once when it installs a database, so a stored id that names no record (or the empty id
  of a new browser) is resolved before any write; otherwise a write before the first read would be
  dropped.
- Writes resolve untracked (the preset lookup, the secret map, the selection), so an `$effect` that
  assigns a forwarded field does not rerun into the next preset on a switch. Reads are tracked.
- Client boundary: `plainClone` (a JSON copy) instead of `$state.snapshot`. `$state.snapshot`
  drops an own `__proto__` key (`seperateParameters.overrides` is user-keyed; see the slice 4
  projection), and the JSON copy of a proxy is plain.
- `setDatabase` keeps `normalizePresets(plainClone(botPresets))` as the client backstop; every
  forwarded-key default, `proxyKey`, `botPresetsId`, and the `loreBookPage` clamp left it.
- `changeToPreset(id)` returns without doing anything for an unknown id. `saveCurrentPreset` writes the five
  keep-on-switch fields into the selected preset only, resolved without the read fallback
  (`selectedPresetForWrite`): while the selection names no record it writes nothing (the
  out-of-bounds push and the `botPresetsId === -1` branch are gone).
- Deleting a preset (`botpreset.svelte`) captures `{ id, name }` before the confirm, re-resolves by
  id after it, rechecks the one-preset minimum, and switches (without saving into the doomed
  preset) only when the deleted preset was selected; the old code always switched to preset 0.
  Its `proxyKey` entry is deleted.
- `proxyKey`: writing `""` (or a non-string) deletes the entry, so the map holds only real keys.
  The preset records keep their now-unused `proxyKey` field until slice 7 removes it from
  `PRESET_FIELDS`; an import writes `""` there. A key stored in a preset record before this slice
  is not moved to the map (no migration owed): such a store shows an empty `proxyKey`.
- `applyPresetTemplate(template)` (new, `database.svelte.ts`) is the onboarding path: the template
  replaces the selected preset through `normalizePreset`, keeping its id, name, and image, then
  `setPreset` copies the template's keep-on-switch fields.
- Wrappers: the function binding writes through `updateSettingValue`, which skips a value equal to
  the current one (the old write-back effect's guard), so `onChange` fires once per edit.
  `SettingSelect`'s hidden-option fallback reads and writes untracked. `SettingSlider`'s
  `customText` reads the value through `getSettingValue`.
- The preset image handler also returns when the file dialog is cancelled (it threw before).
- The selection is kept under the key `risu-selection` in `sessionStorage` (this tab's, read
  first) and `localStorage` (the browser's last choice, the start of a new tab), written on each
  change (Astra point 6).
- Preset hotkeys are ignored while the popup editor is open: it writes its draft back to the
  field it was opened on when it closes (Astra point 2). `setPluginDatabase` awaits the plugin
  install prompt before it assigns anything, so every field lands in the preset selected then.

Tests invalidated (the plan's table said none; 18 cases in 6 files, all from the intended changes,
adapted by the Fable test-adapter, none refused; the re-targeted `saveCurrentPreset` case was
adapted again after Astra point 5):
`presetIds.test.ts` (7: the index signatures of `changeToPreset`, `copyPreset`, `downloadPreset`;
the out-of-bounds push; a `botPresetsId` seeded in the stored root), `presetSchema.test.ts` (2:
the residual root list and the partition, which needs `FORWARDED_ROOT_KEYS`),
`resourceSync.test.ts` (2), `resourceSyncChats.test.ts` (1), and `resourceSyncSections.test.ts`
(5: their stored root holds forwarded keys, or they use `temperature` as the sample root edit),
and `forwardingSpike.test.ts` (1: proof 4 asserts that the real `SettingNumber` loses the edit,
which the rewrite fixes).

Checks: `pnpm check` (source clean; the only errors were the invalidated `presetIds.test.ts`
calls), `pnpm format:check`, and `pnpm build` pass; `pnpm test` shows only the 18 invalidated cases; `pnpm test:e2e`
passes (1).

Playwright (`checkSlice5.mjs` in the session scratchpad, fresh server, system Chrome):

- First boot writes `root+`, `modules+`, `plugins+`; an idle reload writes nothing.
- Three presets P1 to P3. `maxContext = 1234` and `promptSettings.sendName = true`, then
  `changeToPreset(P2)` in the same task: one batch (`presets`, `providers`); after a reload P1 has
  both, P2 is unchanged, and P2 is still selected.
- In the real Bot Settings page (legacy layout), `fill("777")` in Max Response Size, then
  Ctrl+1 with the input focused: the input shows P1's 500 after the switch; after a reload P2 has
  777, P1 is unchanged, and P1 is selected.
- Hotkeys Ctrl+3, Ctrl+2, Ctrl+1 select P3, P2, P1 by id. A send with `presetChain = "P3"`
  selects P3 (the send then fails for lack of a character, as intended by the check).
- The plugin steps (`setDatabase` on the live database with `temperature = 91`, `setDatabaseLite`
  with `maxContext = 9100`) land in P1 and survive a reload.
- `proxyKey = "pk-one"` on P1; after switching to P2 it reads `""`; `copyPreset(P1)` gives the copy
  the entry; importing `{ name: "Hand", proxyKey: "pk-hand" }` puts the key in the map and `""` in
  the record; one batch (`presets`, `llmSecrets`); after a reload the map holds P1, the copy, and
  Hand. Deleting the copy through the preset list UI (trash, YES) removes it and its entry and
  keeps P1 selected.
- `loreBookPage = 1` with two books survives a reload (`localStorage`); after the second book is
  removed it reads 0.
- Two contexts, A on P1 and B on P2: A sets `temperature = 61` (P1); B then sets
  `maxContext = 6200` from a stale `presets` revision, gets a 409, and reloads `presets` (the edit
  is lost, the recorded residual risk); B keeps P2 selected, and B's next edit
  (`maxResponse = 620`) saves into the reloaded P2. After reloads A still has P1 and B P2.
- Settings pages sweep (`checkSettingsPages.mjs`): the same result as slice 4 (only the old page 13
  `PromptSettings` error, and the same writes while browsing, none of them `presets`).

Added after the Astra challenge (`checkSlice5b.mjs`): in Bot Settings, clearing Max Response Size
leaves the input empty (root and record `null`), typing 64 shows 64; after clearing again and a
reload it reads 500 (the server default). Two tabs of one browser context select P1 and P2; after
reloading both, each keeps its own; a third new tab starts on P2 (the last choice). The full
`checkSlice5.mjs`, the settings sweep, `pnpm build`, and `pnpm test:e2e` were rerun after the fixes
with the same results as above.

## Astra challenge (2026-09-30) and decisions

1. Copy, import, and delete change `presets` and `llmSecrets`; a conflict on one reloads it while
   the other retries (for example, a delete whose `presets` conflicts restores the preset and still
   deletes its `proxyKey` entry). **Rejected**: this is the multi-device residual risk slice 7
   already accepted (Astra P4 rejected for this alpha, single-user project); the delete case is
   added to the residual risk below.
2. Asynchronous writers target the preset selected when they finish: the popup editor of
   `TextAreaInput` (it assigned the root working copy the same way before) and
   `setPluginDatabase` after its install prompt. **Adopted, reduced**: the preset hotkeys are
   ignored while the popup editor is open (the other switch paths are behind the popup or an
   alert), and `setPluginDatabase` awaits the prompt before assigning.
3. Clearing a number input showed the default at once (the getter served the default for `null`).
   **Adopted**: a `null` reads as `null` except in a non-nullable container.
4. The getter stored object defaults in the record on a read, so a render or a snapshot could
   dirty a normalized preset. **Adopted with a different fix**: the getter never writes;
   `normalizePreset` canonicalizes a `null` outside `PRESET_NULLABLE_FIELDS` and the keep-on-switch
   fields (a contract change from slice 2, which kept every `null`; the fields slice 2 kept it for
   are all in the list).
5. A read before a write resolves the fallback and so redirects the write: `updateSettingValue`'s
   equality read, and `saveCurrentPreset`. **Adopted for `saveCurrentPreset`**
   (`selectedPresetForWrite`). **Rejected for the wrappers**: a user edit always follows a render,
   which already resolved the selection, so the edit goes to the record the page shows.
6. Two tabs of one profile shared the stored selection. **Adopted**: `sessionStorage` per tab,
   `localStorage` as the start of a new tab.

Astra's testing advice goes to the Fable reviewer.

## Review

Fable reviewer (2026-09-30): no problem. It confirmed the 18 adaptations as expected invalidations, found that challenge points 1 and 5 (the wrappers) hold as rejected, and judged the testing advice (all necessary except the conflict tests of point 1 and the number-input intermediates of point 3). It wrote `forwarding.test.ts` (with `reactiveProbe.svelte.ts`),
`selection.test.ts`, `settingWrappers.test.ts`, `src/ts/hotkey.test.ts`,
`src/ts/plugins/apiV3/v3SetDatabase.test.ts`, three null-canonicalization cases in
`presetSchema.test.ts`, and `e2e/presetSelection.spec.ts`. After it: `pnpm test` 75 files, 769
passed, 3 skipped; `pnpm test:e2e` 3 passed. Residual, recorded: a user-defined "send" hotkey
(none by default) on a character with `presetChain` can still switch the preset while the popup
editor is open.
