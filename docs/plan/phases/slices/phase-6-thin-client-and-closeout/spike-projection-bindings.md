# Slice: Spike, Projection Binding Pattern

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Projections" (the binding pattern
every projection uses) and the Safety Contract ("no projection recreates an aggregate database
under another name"); `PLAN.md` End State ("the client keeps per-screen projections of server
data ... and writes only through explicit mutation calls"), invariant 2 (every write ends in an
explicit mutation; the adapter is deleted per collection), invariant 3 (the shape of
`DBState.db` shrinks last).

Depends on: Phase 3 slice 1 (`spike-forwarding-layer`: the accessor proofs over the installed
Svelte proxy, `src/ts/storage/tests/forwardingHarness.svelte.ts`) and slice 5 (the synchronous
function-binding wrappers). Phase 4 (the allowlist of core-app writers its closeout records: the
write shapes the pattern must cover). No Phase 5 dependency. First slice of the phase, in
parallel with `live-updates`.

## Scope

Allowed files: `src/ts/storage/tests/projectionSpike.test.ts` (new), `src/ts/storage/tests/projectionHarness.svelte.ts`
(new; the prototype write-through record, test-only), and the verdict appended to this file. No
production file. The production owner of the chosen implementation is `settings-ownership`,
which creates `src/ts/storage/records.svelte.ts` from the harness (Astra P7, Opus P13).

Identifiers (verified 2026-09-30; every count is matching lines, tests excluded): the binding
inventory the pattern must serve: 394 `bind:` sites onto `DBState.db` in 25 files under
`src/lib` (`rg -n 'bind:[A-Za-z]+=\{?DBState\.db' src/lib`); by family: character-owned 80
(`CharConfig.svelte` 71, `LoreBookSetting.svelte` 5, `LoreBookList.svelte` 2, `Sidebar.svelte`
2), preset-owned 147 (`BotSettings.svelte` 59, `OobaSettings.svelte` 43 of which 42 are nested
`reverseProxyOobaArgs.*`, `PromptSettings.svelte` 22, `EasyPanel.svelte` 11,
`AuxModelSelectors.svelte` 5, `OpenrouterSettings.svelte` 4, `SeparateParametersSection.svelte`
2, `CustomSidebar.svelte` 1), personas 4, plugins 4, other root settings 159
(`OtherBotSettings.svelte` 96 of which 20 are nested `NAIImgConfig.*`, 9 `sdConfig.*`, 8
`comfyConfig.*`, 5 `openaiCompatImage.*`); plus 5 getter/setter chat bindings
(`CharConfig.svelte:468-471, 1753-1758, 1786-1791`, `DevTool.svelte:133-139, 143-149`) the
single-line regex does not match. The direct-assignment shapes of Phase 4's allowlist (its
closeout slice): handler assignments (`DBState.db.x = v`), `push`/`splice` onto a collection
(`characters`, `modules`, `personas`, `botPresets`, `customModels`, `translatorPresets`,
`hypaV3Presets`, `loreBook`, `hotkeys`), whole-array replacement (`DBState.db.characterOrder = [...]`),
and the cast form `(db.characters[i] as character).x = v`; 249 matching lines in 31 files under
`src/lib` and 53 in 16 under `src/ts` today with the regex
`DBState\.db(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^\]\n]+\]|[[:space:]]+as[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*\)?)*[[:space:]]*(?:\?\?=|\|\|=|\+=|-=|=(?![=>])|\+\+|--)`
(`rg -P`). The declarative registry: 155 `bindKey` items across
`src/ts/setting/{accessibility,advanced,botSettingsParams,chatFormat,display,language}SettingsData*.ts`,
read and written through `getSettingValue`/`setSettingValue` (`src/ts/setting/utils.ts:30-64`:
`item.getValue(DBState.db, ctx)` and `item.setValue(DBState.db, value, ctx)` first, then
`bindPath`, then `bindKey`; 8 `getValue`/`setValue` item pairs in
`displaySettingsData.svelte.ts:417-454`) and `SettingSegmented.svelte:53`
(`bind:value={(DBState.db as any)[item.bindKey]}`); `SettingRenderer.svelte:20-28` passes the
live `DBState.db` as `ctx.db`. The Phase 3 harness (`forwardingHarness.svelte.ts`) and its proofs
1 to 6. The Svelte 5.57.1 proxy facts the Phase 3 spike records (accessor descriptors survive
`$state`; `deleteProperty` shadows reads). Phase 4's `characterStore.svelte.ts` (`updateCharacter`,
`replaceCharacterFields`, `addCharacter`, `removeCharacter`), `collectionStore.svelte.ts`
(`updateSettings`, `setPersonas`, `setModules`, ...), `pluginStorageStore.svelte.ts`: the
functions a write-through record's `onWrite` must reach.

Stopping condition: neither candidate pattern below passes all proofs for a reason the design
cannot fix (not a harness bug). The spike stops, records which proof failed, and the projection
slices run in the fallback form (explicit function bindings at every site, calling the Phase 4
mutation functions).

## Assumptions

- Phase 3 shipped the accessor forwarding layer (its spike passed) and the synchronous
  function-binding wrappers (`bind:value={() => get(), (v) => set(v)}`); if Phase 3 ran in its
  fallback form (`SelectedPreset`/`SelectedPersona` projections written by id), that projection
  is already a write-through record and this spike only extends it to nested containers.
- The Svelte proxy behaves as the Phase 3 spike recorded (5.57.1 source): an accessor on the raw
  object is honored by `bind:`, `$state.snapshot`, `JSON.stringify`, and `Object.keys`.
- Phase 4 (`character-and-collection-mutations`, `closeout`, verified against its slices): the
  contract writers (plugins, MCP, Lua, triggers, importers) go through `characterStore`,
  `collectionStore`, and `pluginStorageStore`; the core-app writers (the `bind:` sites, the
  handler assignments and collection pushes under `src/lib`, `characters.ts`,
  `lorebook.svelte.ts`, `modules.ts`, `bootstrap.ts`, `index.svelte.ts`, `group.ts`,
  `persona.ts`, `colorscheme.ts`, the settings wrappers, `stores.svelte.ts:174`) are left direct
  for Phase 6 in an allowlist. The pattern therefore has to serve every shape in that allowlist,
  not only `bind:` (Opus P13).

## Proposed decisions

- Owner verdict line (Opus P13): the plan owner accepts the write-through record below as the
  mutation boundary for projections (a property `set` that synchronously calls the record's
  Phase 4 mutation function with the id and revision captured at the write is the explicit
  mutation of invariant 2; it is not `$effect` diffing), or the fallback applies: explicit
  function bindings at every site. The verdict is recorded here before the first projection
  slice starts.
- Candidates (proposed; the spike measures both on the same proofs):
  1. **Accessor-backed record** (Phase 3's technique generalized): `projectRecord(read, write)`
     builds a plain object with one enumerable accessor per top-level field of the record; the
     getter reads the underlying `$state` record; the setter calls the record's mutation
     synchronously (`updateCharacter(chaId, { [field]: value })`, `updateSettings({ [field]: value })`,
     or the collection setter), which validates, writes the mirror, and queues the record write.
     Nested containers are returned as the underlying `$state` sub-objects, so a nested `bind:`
     writes into the store without passing the setter; the write is then recorded by candidate 2
     for that container or by a field-level call the nested editors make (the Phase 2
     `useLocalLoreDraft` precedent: an editing copy saved through one mutation on every change).
  2. **Deep write-through record**: `trackedRecord(record, onWrite)` wraps the `$state` record in
     a JS `Proxy` whose `get` returns nested wrappers carrying their path and whose `set` (and
     `deleteProperty`) forwards to the Svelte proxy and calls `onWrite(topLevelField)` in the same
     task. Every write, top-level or nested, `push`/`splice` included (they set indices and
     `length`), becomes one queued patch for the record with the revision captured at the write.
     Wrappers are cached per target in a `WeakMap`.
- Proofs, each a vitest case over the harness with two section records, one preset record, and
  one character record with a 300-entry `loreBook`, run against `storeBackedServer.ts` where a
  write is involved:
  1. `bind:value` on a top-level field, on a nested field (`reverseProxyOobaArgs.temperature`),
     and on an array element (`loreBook[3].content`) writes into the record and queues exactly one
     patch for that record with the revision the client holds; a second write within the debounce
     coalesces into the same patch.
  2. `$state.snapshot`, `JSON.stringify`, `Object.keys`, and a JSON clone of a projection yield
     plain data equal to the record (no wrapper leaks into a snapshot).
  3. Every allowlist shape: a handler assignment, `push`, `splice`, `sort`, and `unshift` on a
     nested array (the lorebook reorder in `LoreBookList.svelte`), a whole-array replacement
     (`characterOrder = [...]`), the cast form, and a `delete` of a key are each captured as one
     patch.
  4. The registry path: `getSettingValue`/`setSettingValue` over a projection with `bindKey`,
     `bindPath`, and the item-level `getValue`/`setValue` functions resolve and write the same way
     as over `DBState.db` today.
  5. Cost: 1,000 sequential nested writes into the 300-entry character record and a re-render of
     a component bound to 60 fields; the write path must not serialize the whole record per
     keystroke (serialization happens once per debounce cycle, as today's `projectCharacter`).
  6. Edit-then-switch: an edit on the selected preset projection followed in the same task by a
     selection switch lands in the original record (Phase 3's proof 6 over the new pattern).
  7. Live replacement: replacing the underlying record (a conflict reload or a live-update event)
     while a component is bound re-renders from the new record and a later write targets the new
     record with its revision.
- Verdict rule (proposed): candidate 2 is adopted as the general pattern if proofs 1 to 7 pass
  and proof 5 stays within 2x of today's binding cost; candidate 1 is adopted for the section
  records (flat, where nested containers are few) with candidate 2 for characters and presets if
  candidate 2 fails only proof 5. If both fail a correctness proof, the fallback is explicit
  function bindings at every site calling the Phase 4 functions, and the projection slices'
  allowed files stay the same.
- The transport the pattern feeds (owned by `settings-ownership`): `queueRecordWrite(kind, id)`
  marks a record for the next cycle (the record is serialized at flush time from the store, as
  `projectCollection` and `projectCharacter` do today), so the wire contract (`{ kind, id, baseRevision, data }`
  whole-record ops) does not change in this phase. Phase 3 chose whole-record sections and Phase
  4 rejected a second op protocol for records; per-field section ops are not in this phase.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`. The seven proofs in vitest, the timing of proof 5
recorded here with the machine, and the verdict recorded here. No production behavior changes.

## Residual risk

The harness covers three record shapes; a settings page may bind a shape the spike did not
exercise (a `null` container such as `promptTemplate` or `reverseProxyOobaArgs`). The projection
slices report such a site as a stopping condition rather than inventing a third pattern.
