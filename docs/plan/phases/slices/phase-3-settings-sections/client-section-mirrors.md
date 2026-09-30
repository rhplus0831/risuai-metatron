# Slice: Client Section Mirrors And The Residual Root

Status: implemented (2026-09-30); see Implementation record.

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

## Requirements from slice 3 (Astra challenge)

- Own `__proto__` keys: `llmSecrets.presets` (built with `Object.fromEntries`) and
  `globalChatVariables` accept an own `__proto__` key, but `$state.snapshot` drops it (Astra ran
  the installed Svelte on both). A projection through `$state.snapshot` would then differ from the
  normalized text, and an idle boot would write the map without that key. The projection and the
  mirror hydration for these maps must preserve own keys (the `pluginStorage` serialization
  exception is the model); audit the other user-keyed maps (`OaiCompAPIKeys`,
  `seperateParameters.overrides`) the same way, and test hydration, projection, reload, and
  no-echo with such a key.
- `presets/main` is materialized by the server (slice 3). `modules`, `plugins`, and
  `pluginStorage` are not; the assembly keeps its client defaults for them unless this slice
  materializes them too.

## Implementation record

Implemented by Claude Opus on 2026-09-30, following `implementation-plan.md` (amendments A2, A4,
A5, F-a, A12).

- Assembly (`bootstrap.ts`, `assembleDatabase`, now exported, F-a): the `RESIDUAL_ROOT_KEYS` of
  the stored `root` (a root from before holds more; that is ignored, A2), every field of each
  section, each collection (`{ items, selectedId }` unpacked into the two fields), the
  `llmSecrets` `presets` map into `llmSecretPresets`, `presets`, then the optional Phase 1
  collections and the characters. A missing section, settings collection, or `presets` record
  throws: the server creates them (slice 3). `modules`, `plugins`, and `pluginStorage` stay
  optional, as before.
- `setDatabase` keeps only the removed-feature deletions, the Phase 1 guards, and the defaults
  and migrations of the residual keys (the preset working copy with `normalizePresets`, the
  persona fields, `botPresetsId`, `selectedPersona`, `loreBookPage`; A4). The statements were
  filtered by the owner of the field they assign (`shared/sections.ts`), then reviewed by hand:
  the `loreBook` default, `normalizeTranslatorPresetState`, the `largeChatPerformanceMode`
  deletion, and the `ollamaCloudModel` copy went with their sections. `checkNewFormat` keeps
  only its character and module steps; the persona id step, the `formatversion` branches, the
  `characterOrder` default, and the `mainPrompt` migrations are gone (no migration owed).
- Save adapter (`resourceSync.svelte.ts`): `COLLECTIONS` adds the 5 sections and 13 collections;
  one debounce loop with a dirty key per record (open question 1). The residual root projects
  `RESIDUAL_ROOT_KEYS` in list order through `$state.snapshot`. A section projects its
  `SECTION_FIELDS` in order, and a settings collection its value or `{ items, selectedId }`.
  Both are serialized straight from the proxy with `JSON.stringify` (the `pluginStorage` model),
  so an own `__proto__` key survives (slice 3's Astra point 4). Each record has its own watcher,
  which reads through the projection, so an edit marks only its record. `applyToMirror`
  replaces a section's fields in place (deleting absent ones), replaces a collection, and
  replaces `llmSecretPresets`.
- `llmSecrets.svelte.ts` (new): `llmSecretPresets` with `getPresetSecret`, `setPresetSecret`,
  `deletePresetSecret`, `copyPresetSecret`, and `replacePresetSecrets` (built with
  `Object.fromEntries`).
- Selection by id: `shared/database.ts` makes `translatorPresetId` and `hypaV3PresetId` strings
  (A5). `getCurrentTranslatorPresetFromState` finds by id, falls back to the first preset, and no
  longer writes the state (it wrote the two legacy fields). `normalizeTranslatorPresetState` and
  `syncCurrentTranslatorPresetToLegacyFields` are gone. `selectedHypaV3Preset` in
  `shared/hypaV3Presets.ts` serves `getCurrentHypaV3Preset`, the `stores.svelte.ts` toggle
  effect, and `OtherBotSettings.svelte`. Both settings pages select, rename, delete, export, and
  import by id; the HypaV3 JSON export already wrote `{ name, settings }` (slice 2).
- Other readers: the Vertex token refresh stops calling `setDatabase`. The browser-local import
  checks `irisDialogue` in `ui` and `googleSearchCredentials` in `secrets`. The
  `scrollToActiveChar` filter moves from `setDatabase` to `activeHotkeys` (`hotkey.ts`, used by
  the dispatch and `HotkeySettings.svelte`). The writes of two dropped fields go:
  `db.cipherChat = false` (`openAI/requests.ts`) and `claudeCachingExperimental = true`
  (`WelcomeRisu.svelte`). No dropped field has a reader left.

Deviations from this file:

- Allowed files added: `shared/hypaV3Presets.ts` (`selectedHypaV3Preset`),
  `src/lib/Setting/Pages/HotkeySettings.svelte` (the hotkey filter's second reader),
  `src/ts/process/request/openAI/requests.ts`, and `src/lib/Others/WelcomeRisu.svelte` (the
  dropped-field writers).
- Section projections use `JSON.stringify` of the live proxy, not `$state.snapshot` per field
  (the `__proto__` requirement above).
- `DROPPED_FIELDS` stay declared in `Database`; slice 7 records the list. The assembly never
  produces them.

Behavior change, as recorded in slice 3: a store from before this slice starts with the section
and collection defaults. Its old `root` values are not carried over, and the first boot writes
the filtered `root` once.

Checks:

- `pnpm check` and `pnpm test`: the only failures are the expected invalidations, listed below.
- `pnpm build` passes.
- `pnpm format:check` is clean.

Expected invalidations, with their causes:

- `resourceSync.test.ts` (the no-echo boot and the load-time normalization) and
  `resourceSyncChats.test.ts` (every boot): the fixtures seed a `root` holding the section
  fields and build `DBState.db` by hand, without the section records.
- `characters.test.ts`: `characterOrder` is read from `root` and now lives in its own
  collection.
- `browserLocalImport.test.ts`: the two fields are expected in `root`, and the run test depends
  on that.
- `translator/presets.test.ts`: the removed legacy functions and the numeric id. It also fails
  `pnpm check`.

Playwright (`playwright-core` scripts, system Chrome, fresh server):

- First boot: the only batch creates `root`, `modules`, and `plugins`. The defaults show:
  `zoomsize` 100, `loreBookToken` 8000, 24 hotkeys, one persona, `maxResponse` 500. Both
  selections resolve by id.
- An idle reload writes nothing.
- Edits persist across a reload:
  - One edit per section plus several collections (`globalChatVariables`, `enabledModules`, a
    second translator preset selected, a second lorebook, `statics.messages`) and a residual
    `temperature` are saved in one batch.
  - Every value survives, including a `llmSecretPresets` entry.
- Two contexts: `ui` edited in one and `providers` in the other gives no conflict. Two `ui` edits
  give the second client a 409; it reloads `ui`, loses its own edit, keeps the first client's,
  and shows the reload notice.
- Every settings page opens without an error except page 13 (the prompt template editor, opened
  directly without a `promptTemplate`). That error, and a write while browsing, happen on the
  slice 3 commit too: there the write goes to `root`, and here to `providers`.

After the Astra challenge (same session):

1. The `presets` projection used `$state.snapshot`, which drops an own `__proto__` key inside a
   preset (`seperateParameters.overrides`), so an unchanged preset would be written without it.
   Adopted: `presets` is serialized straight from the proxy, like `pluginStorage`, and its watcher
   reads through the projection.
2. `setPresetSecret` could not create an own `__proto__` entry through the proxy. Adopted: that
   one id rebuilds the map with `Object.fromEntries` (the `setSafeLocalPluginValue` model).
3. Plugin setters (regression): the full setter's `setDatabase` no longer puts back a default
   after a plugin writes `null` or `undefined` to a server-normalized field. `personas: null`
   then breaks readers, and `askRemoval: null` disables a confirmation locally. Adopted: both
   plugin setters (`v3.svelte.ts`, `assignPluginField`) refuse `null` and `undefined` for
   section, collection, and selection fields, keep the value, and warn. A malformed non-null
   value still reaches the server, which repairs it. The mirror then differs until the next
   reload, as with any write the server normalizes further. `v3.svelte.ts` joins the allowed
   files.
4. The rename and delete dialogs held the preset object and list across the `await`, so a
   conflict reload meanwhile made them edit a detached copy. Adopted in both settings pages: they
   capture the id and name, then resolve by id afterwards and recheck the one-preset minimum.
   Delete moves the selection only when it pointed at the deleted preset.
5. Not fixed, recorded: a `ui` conflict reload assigns the fields but does not rerun the
   presentation functions (language, theme, CSS, animation speed, sizes). The same held for
   `root` before. Also, "an idle boot writes nothing" excludes two intended boot mutations:
   `checkCharOrder`, which repairs `characterOrder` against the characters, and `WelcomeRisu`
   onboarding, which writes the browser language.
6. Docs: `STRUCTURE.md` D2 and the `persistence.md` "Add a persisted setting" recipe now put a
   section field's default in its server normalizer. The browser-local import flow and
   `global-api.md` name the `ui` and `secrets` records.

Tests: the Fable test-adapter adapted the five invalidated files and refused none. The
`resourceSync` no-echo test now boots from the materialized records through `assembleDatabase`
and still proves that an idle boot writes nothing. The two `normalizeTranslatorPresetState` tests
were removed with the function, whose job moved to the server normalizer (covered in
`normalizeCollections.test.ts`). `resourceSyncUnload.test.ts` still passes on the old fixture
shape and was left unchanged. After the fixes, all checks pass:

- `pnpm check`
- `pnpm test` (66 files, 693 passed, 3 skipped)
- `pnpm format:check`
- The Playwright script, which gave the same results as above.

Review-step tests (Claude Fable, the slice 4 review): `src/ts/storage/tests/resourceSyncSections.test.ts`
(the convergence rule on the real server store for every kind, `assembleDatabase`, the residual
root projection, one watcher per record, the conflict reloads), `src/ts/storage/tests/llmSecrets.test.ts`,
`src/ts/process/memory/hypaV3Presets.test.ts`, the plugin-setter cases in
`src/ts/plugins/apiV3/hostApi.test.ts`, the dialog-during-conflict cases in
`src/lib/Setting/Pages/Language/TranslatorPresetSettings.test.ts`, and `e2e/idleReload.spec.ts`
(`pnpm test:e2e`). The duplicated `materialize` helper of the adapted tests moved to
`src/ts/storage/tests/serverKinds.ts`, and `resourceSyncUnload.test.ts` boots from the materialized
records like the others.
