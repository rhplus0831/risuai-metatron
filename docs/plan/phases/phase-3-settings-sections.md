# Phase 3: Settings Sections

Status: not started.

Depends on: Phase 1. Independent of Phase 2. Implements the Phase 3 part of Decision 3 in `PLAN.md`.

## Objective

Split the `root` resource into typed sections with server-side defaults, move the remaining
collections out of root into their own resources, and separate per-client selection state from
data.

## Required Work

- **Sections.** Use the field taxonomy from the opening baseline: `providers` (45 provider
  settings), `secrets` (29 credential fields), `ui` (120 preferences), and `memoryTranslateMedia`
  (66 fields). The 75 preset-owned fields are not a section: they live only in the presets and are
  reached through the forwarding layer below. The 22 transient or legacy fields are dropped or
  become server-only state; record each in this file.
- **Remove the working copies.** `changeToPreset`, `saveCurrentPreset`, and `setPreset` in
  `src/ts/storage/database.svelte.ts` copy the selected preset into root and back, and
  `changeUserPersona` and `saveUserPersona` in `src/ts/persona.ts` do the same for `username`,
  `userIcon`, `personaPrompt`, and `userNote`. Replace both copies with a forwarding layer:
  `DBState.db` keeps the field names (D3) and reads and writes the selected preset or persona;
  every forwarded write is a mutation carrying the id captured at edit time, which replaces the
  current preset watcher (it observes only the selection and the array length). The Svelte 5
  `$state` proxy rejects accessors added through `defineProperty` (`state_descriptors_fixed`), so
  install enumerable accessors on the raw root before it is proxied and reinstall them in
  `setDatabaseLite` and plugin `setPluginDatabaseLite`. First run a spike on one settings page that
  proves the layer against `bind:value`, `$state.snapshot` (plugin `getDatabase` snapshots and
  exports), the `for ... in` root diff in `saveDb`, plugin `setPluginDatabase` writes, and an edit
  followed by an immediate selection switch and a reload, which must leave the edit in the original
  record. If the spike fails, add an explicit selected preset and persona projection and move the
  call sites to it instead.
- **Field map.** The layer maps the names that differ between root and preset: `NAIsettings` and
  `NAISettings`, `reasoningEffort` and `reasonEffort`, and `presetRegex` and `regex`. This map is
  the canonical preset field list the normalizer uses. A preset missing a field now gets the normalizer default instead of
  inheriting the previous preset's value through `newPres.x ?? db.x`; record this behavior change.
- **Keep-on-switch settings.** Deferred (Decision 3): `setPreset` honors
  `doNotChangeSeperateModels`, `doNotChangeFallbackModels`, and
  `disableSeperateParameterChangeOnPresetChange`, which keep `seperateModels`,
  `seperateModelsForAxModels`, `fallbackModels`, `fallbackWhenBlankResponse`, and
  `seperateParameters` across a switch. This phase leaves those five fields and the three toggles
  on today's path: root fields that `setPreset` and `saveCurrentPreset` copy exactly as today,
  outside the forwarding layer and the field map. Record the remaining cross-client shared-copy
  hazard for them in this file. The follow-up after this plan decides their owner.
- **Ids.** Presets gain a required id and `RisuPersona.id` becomes required, both assigned by the
  normalizer. `copyPreset` and `importPreset` assign fresh ids, and `downloadPreset` strips the id
  so `.risup` stays byte-compatible. The normalizer keeps at least one preset, which removes the
  `botPresetsId === -1` branch in `saveCurrentPreset`, and falls back to the first record when a
  selected one disappears. `translatorPresetId` and `hypaV3PresetId` become ids with their
  collections. `selectUserImg` in `src/ts/persona.ts` assigns a new `v4()` id on
  every icon change, which breaks `bindedPersona` references; it keeps the id instead.
- **Collections still in root.** `loreBook`, `globalscript`, `hotkeys`,
  `customSidebarItems`, `characterOrder`, `authRefreshes`, `globalChatVariables`, `personas`,
  `translatorPresets`, `hypaV3Presets`, `customModels`, and `enabledModules` become small resources
  of their own.
- **Server normalizers.** Port the defaults and migrations in `setDatabase` section by section to
  pure functions under `server/src/data/normalize/` with node-environment tests, including the
  preset consistency rules between `botPreset`, `presetTemplate`, `saveCurrentPreset`, `setPreset`,
  and `importPreset` (the field sets differ today; the normalizer makes one list canonical). The
  client `setDatabase` shrinks by the same sections.
- **Client mirror.** `DBState.db` keeps the same field names (invariant D3), but each section is a
  mirror with its own debounced write. The root watcher in `saveDb` is replaced by per-section
  watchers, each deleted when its section gets explicit mutation functions.
- **Selection state.** The selected preset and persona become per-client ids, and `loreBookPage`
  becomes per-client UI state, in a client-local store (`localStorage` is acceptable). The mirror
  derives `botPresetsId` and `selectedPersona` from the ids until Phase 6. The selected chat is
  Phase 2's.
- **Secrets.** Split credentials per Decision 6: LLM provider credentials go to `llmSecrets`, the
  rest to `secrets`. `openAIKey` is effectively global today (`setPreset` never restores it), so it
  stays one global entry; `proxyKey` leaves the preset objects for `llmSecrets` keyed by preset id,
  and preset copy, delete, and import carry that entry. The forwarding layer resolves it for the
  selected preset. Both sections stay readable by the client until Phase 5 makes `llmSecrets` write-only,
  because the client still calls providers through the proxy. Mark `llmSecrets` so Phase 5 can flip it
  without a schema change.
- **Preset formats.** `downloadPreset` and `importPreset` keep the `.risup` and `.risupreset`
  formats byte-compatible (invariant D5).
- **Docs.** `docs/structure/persistence.md` (`State`, `Recipes`), `docs/structure/settings-i18n.md`,
  and the D2 invariant, which now points at the server normalizers.

## Safety Contract

A fresh server produces the same normalized database as `setDatabase` did: compare a snapshot of
`getDatabase()` after boot on an empty save before and after the phase, ignoring the fields this
file records as dropped, with the forwarded fields read through the layer. Settings pages keep
binding to `DBState.db`.

## Exit Criteria

- No `root` resource remains.
- Every section and collection has a normalizer with tests, and the client `setDatabase` contains no
  defaults for migrated sections.
- The empty-save boot snapshot matches, apart from the recorded drops.
- Preset export and import round-trip against a `.risup` file produced before the phase.
- No root working copy of a preset or persona remains, and switching presets or personas on one
  client does not change another client's settings or presets.
- A chat bound to a persona keeps its binding after the persona's icon changes.

## Validation

Normalizer tests, a boot-snapshot comparison recorded in the phase file, a preset round-trip check,
and `pnpm check`, `pnpm test`, `pnpm format:check`.
