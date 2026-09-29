# Slice: Client Section Mirrors And The Residual Root

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 3](../../phase-3-settings-sections.md), "Client mirror", "Collections still in
root" (the client side), "Server normalizers" (the client `setDatabase` shrinks), "Ids" for
`translatorPresetId` and `hypaV3PresetId`, and the client side of "Secrets"; `PLAN.md`
invariants 2, 3, and 5.

Depends on: slice 3 (the kinds exist, are materialized, and are normalized at startup). Not on
the spike: no accessor exists yet. `root` shrinks to a residual record; it is removed in slice 6.

## Scope

Allowed files: `src/ts/bootstrap.ts` (`assembleDatabase`, `checkNewFormat` root steps,
`loadData`), `src/ts/storage/resourceSync.svelte.ts` (`COLLECTIONS`, `COLLECTION_FIELDS`,
`projectCollection`, `projectRecord`, `applyToMirror`, the watchers in `startResourceSync`),
`src/ts/storage/llmSecrets.svelte.ts` (new: the client state of the `llmSecrets` record's
`presets` map, see below), `src/ts/storage/database.svelte.ts` (`setDatabase` shrinks),
`src/ts/storage/database.setDatabase.test.ts` only if its fixtures need the new shape,
`src/ts/storage/browserLocalImport.ts` (`irisDialogue` and `googleSearchCredentials` land in
their sections), `src/ts/stores.svelte.ts` (the `hypaV3Presets[hypaV3PresetId]` lookup becomes a
find by id), `src/ts/process/memory/hypav3.ts` (`getCurrentHypaV3Preset` by id),
`src/ts/translator/presets.ts` (`getCurrentTranslatorPresetFromState` by id; the legacy sync
function goes), `src/lib/Setting/Pages/OtherBotSettings.svelte` and
`src/lib/Setting/Pages/Language/TranslatorPresetSettings.svelte` (select by id; the HypaV3 JSON
export at `OtherBotSettings.svelte:1250` strips `id`: Opus P10), `src/ts/process/request/google.ts`
(the Vertex token write stops calling `setDatabase`), `src/ts/hotkey.ts` (the
`enableScrollToActiveChar` filter moves here from `setDatabase`), the readers of the dropped
fields the report lists, and the test fixtures that seed a `root` record:
`src/ts/storage/tests/{resourceSync,resourceSyncChats,resourceSyncUnload,browserLocalImport,resourceClient}.test.ts`,
`src/ts/characters.test.ts` (Opus P14: `backuplocal.test.ts` and `snapshots.test.ts` have no
`root` reference; the server fixtures `resourceStore.test.ts`, `resources.test.ts`,
`resourcesBatch.test.ts`, `backups.test.ts` move in slice 6 with the kind). Tests belong to the
review step.

Identifiers (verified): `assembleDatabase` (builds `Database` from `root` plus the four
collections; defaults an empty preset list to `presetTemplate` and `botPresetsId = 0`),
`seedResources`, `startResourceSync` (marks every collection once; the root `$effect` snapshots
every non-excluded key), `projectCollection` (`root` branch: `for (const key in db)`),
`applyToMirror` (`root` branch: replaces keys and deletes absent ones; collection branch:
replaces the array), `COLLECTIONS`, `COLLECTION_FIELDS`, `excludedRootKeys`; `setDatabase` and
`setDatabaseLite`; `checkNewFormat`; `checkCharOrder`; the `stores.svelte.ts` `$effect.root` that
reads `hypaV3Presets?.[hypaV3PresetId]`; `getCurrentHypaV3Preset`;
`getCurrentTranslatorPresetFromState`, `syncCurrentTranslatorPresetToLegacyFields`; the Vertex
`generateToken` in `google.ts` (`setDatabase(db2)` after writing `vertexAccessToken` and
`vertexAccessTokenExpires`).

Stopping condition: a reader that needs a field the assembly no longer produces, or a section
whose projection text differs from the server's normalized text on an idle boot (an echo write on
every boot), which means a normalizer and the assembly disagree on a default or a key order.

## Assumptions

- After slice 3 the server materializes every section and collection singleton and normalizes
  stored records at startup, so `assembleDatabase` finds every kind present and applies no
  defaults; a missing record is a server error, not a client fallback.
- The residual `root` after this slice holds exactly: the 77 `setPreset` targets (the preset
  working copy, still copied by `changeToPreset`/`setPreset`/`saveCurrentPreset` until slice 5),
  `username`, `userIcon`, `personaPrompt`, `userNote` (the persona working copy, until slice 6),
  and `botPresetsId`, `selectedPersona`, `loreBookPage` (the selection indexes, until slices 5
  and 6). `RESIDUAL_ROOT_KEYS` in `shared/sections.ts` (slice 2) names them; the root projection
  and watcher iterate that explicit list, not `for ... in`. Nothing else is in `root`.
- `DBState.db` keeps every field name flat (D3); a "section mirror" is a projection of the same
  object, not a new object, so no component changes.
- `hypaV3PresetId` and `translatorPresetId` are string ids from slice 3's collection shape; the
  readers are the ones listed above.

## Proposed decisions

- Assembly (decided by the phase file; shape proposed): `assembleDatabase` spreads the five
  section records and the twelve collection records into one object (`translatorPresets` and
  `hypaV3Presets` unpack `{ items, selectedId }` into their two `Database` names), then the
  residual `root`, the Phase 1 collections, and the characters. A key of a section record that is
  not in `SECTION_FIELDS` is ignored. `checkNewFormat` keeps only its character and module
  steps; `formatversion` leaves the schema (no migration owed). `checkCharOrder` stays.
- Per-section projection and watchers (decided by the phase file; one loop proposed):
  `COLLECTIONS` grows to the sections, the collections, and the residual root, each with a
  `project` (the fields in `SECTION_FIELDS` order, snapshot per field; a collection's value
  as-is; the `{ items, selectedId }` pair; the residual root's explicit key list) and a watcher
  `$effect` that reads exactly those fields. One debounce and one batch per cycle serve every
  section through per-section dirty keys ("own debounced write" read as "own dirty key and
  projection", an open question for the plan owner in the report). `applyToMirror` assigns a
  section's fields in place and replaces a collection's value.
- `llmSecrets` client state (Astra P6: an owner): the flat fields of the `llmSecrets` record
  mirror into `DBState.db` like any section; its `presets` map is not a `Database` field and
  lives in `src/ts/storage/llmSecrets.svelte.ts` as `llmSecretPresets` (`$state`
  `Record<presetId, { proxyKey }>`), with `getPresetSecret(id)`, `setPresetSecret(id, entry)`,
  `deletePresetSecret(id)`, `copyPresetSecret(from, to)`. This slice assembles it from the record,
  includes it in the `llmSecrets` projection and watcher, and replaces it on a conflict reload
  (`applyToMirror`). Until slice 5 nothing reads it (the preset objects still carry `proxyKey`);
  slice 5's `proxyKey` accessor and slice 7's lifecycle calls use it.
- `setDatabase` after this slice (proposed): keeps the legacy deletions, the `characters`,
  `modules`, `plugins`, and `pluginCustomStorage` guards, `changeLanguage(data.language)`, and,
  until slice 5, the preset working-copy defaults for the residual root keys (they are read from
  the preset by `setPreset` and are removed with it); every other default is deleted with its
  section.
- Dropped fields (decided by the phase file; list proposed): the assembly does not produce
  `DROPPED_FIELDS`; their readers change as the report lists (`formatversion`: none after this
  slice; `translatorPrompt`/`translatorMaxResponse` and `hypaV3Settings`: the selected preset;
  the no-reader fields: nothing). Slice 7 records the list in the phase file.
- Vertex token (proposed): `generateToken` writes the two fields and stops calling
  `setDatabase`; the `llmSecrets` watcher saves them.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Manual, recorded here: fresh
server, first run, every settings page loads with the pre-phase defaults; a field of each section
and each collection survives a reload; an idle reload writes nothing (the `resourceSync` no-echo
test and its boot compare pass extended to every section); two tabs editing fields of different
sections do not conflict, two tabs editing the same section conflict and one reloads with the
notice; a snapshot made after this slice restores (the `root` row is still registered).
Review-step tests: `assembleDatabase` over materialized records, the section watchers marking
only their section, `applyToMirror` per section including `llmSecretPresets`, the residual root
projection listing exactly `RESIDUAL_ROOT_KEYS`, and the id-based lookups for the two preset
collections.

## Residual risk

Every write still reaches the server through the section watchers (invariant 2's adapter);
no section has explicit mutation functions in this phase, so no watcher is deleted (the phase
file should say so per invariant 2; proposed edit in the report). The residual root still
carries the preset and persona working copies with their cross-client overwrite until slices 5
and 6. A settings interaction that touches two sections produces two dirty sections in one batch
(atomic on the server). The old `hypaV3Settings` and translator legacy fields are gone from the
mirror; a plugin that read them through `getDatabase` (they are not in `allowedDbKeys`) never
could.
