# Slice: Settings Ownership

Status: implemented 2026-10-04 (Phase 6 slice 4; the plan review's decisions are recorded in the slice commit and the Stop B report).

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Projections" (the settings
sections as records, the source of truth flipped under the flat mirror) and the settings part
of "Save loop" (the section, collection, `presets`, `modules`, and `plugins` watchers deleted);
`PLAN.md` invariant 2 (the adapter deleted per collection), invariant 3 (the source of truth
changes first, the shape shrinks last), Decision 3 (the forwarding layer stays until the
readers move; its removal is `aggregate-removal`'s).

Depends on: `spike-projection-bindings` (the pattern and the owner verdict). Phase 3 (the
sections, collections, `shared/sections.ts`, `selection.svelte.ts`, `forwarding.svelte.ts`,
`llmSecrets.svelte.ts`), Phase 4 `character-and-collection-mutations` (`collectionStore.svelte.ts`,
`pluginStorageStore.svelte.ts`) and `plugin-host-setters` (the `pluginStorage` watcher already
deleted), Phase 5 `request-layer-and-llm-secrets` (the masked `llmSecrets` projection and the
`/api/llm-secrets` routes). Sequential: `character-ownership` follows this slice (Opus P9).

## Scope

Allowed files: `src/ts/storage/records.svelte.ts` (new: the write-through record implementation
promoted from the spike harness, the production owner of the pattern), `src/ts/storage/collectionStore.svelte.ts`
(Phase 4's module, extended: one record per section and collection kind, `settings.<kind>`
accessors, the transport swapped from the watchers to `queueRecordWrite`; `updateSettings`,
`readSetting`, and the collection setters keep their signatures), `src/ts/storage/pluginStorageStore.svelte.ts`
(its `markPluginStorageDirty` becomes `queueRecordWrite("pluginStorage", "main")`),
`src/ts/storage/forwarding.svelte.ts` (extended: enumerable accessors on the raw root for every
section and collection field forwarding to the records, beside the existing preset and persona
accessors; nothing deleted), `src/ts/storage/llmSecrets.svelte.ts` (the masked status record,
read-only, and the explicit credential methods), `src/ts/storage/resourceSync.svelte.ts` (the
section, collection, `presets`, `modules`, and `plugins` watchers and their `projectCollection`
branches deleted; `queueRecordWrite(kind, id)` exported; `applyToMirror`'s section and
collection branches write the records), `src/ts/storage/database.svelte.ts` (`setDatabaseLite`
installs the extended accessors; `changeToPreset`, `copyPreset`, `downloadPreset`, `importPreset`
call the presets record's setters), `src/ts/bootstrap.ts` (`assembleDatabase`'s section part
builds the records and the root facade), `server/src/data/normalize/modules.ts` (new) and its
registration in `server/src/data/kinds.ts`. No `src/lib` file (the readers move in the reader
slices). Tests belong to the review step.

Identifiers (verified 2026-09-30 on the tree before Phase 3; the Phase 3 and 4 names are from
their slices): the watchers `resourceSync.svelte.ts:1256-1279` (`botPresets`, `modules`,
`plugins`, the root keys; Phase 3 turns the root watcher into per-section watchers; Phase 4
deletes the `pluginCustomStorage` one), `projectCollection` (295-313), `applyToMirror`'s
collection branches (1046-1052), `assembleDatabase` (`bootstrap.ts:120-150`); the Phase 3
modules: `shared/sections.ts` (`SECTION_KIND`, `SECTION_FIELDS`, `COLLECTION_KIND`,
`FORWARDED_PRESET_KEYS`, `DROPPED_FIELDS`), `shared/presets.ts`, `forwarding.svelte.ts`
(`installForwarding(raw)`, idempotent by descriptor check, installed in `setDatabaseLite` on the
raw object), `selection.svelte.ts`, `llmSecrets.svelte.ts` (`llmSecretPresets`); the Phase 4
modules: `collectionStore.svelte.ts` (`updateSettings(patch, { presetId? })`, `readSetting`,
`setPersonas`, `addPersona`, `updatePersona`, `setModules`, `addModule`, `updateModule`,
`removeModule`, `setEnabledModules`, `setModuleEnabled`, `setCharacterOrder`, `setPlugins`,
`upsertPlugin`, `setPluginArgument`, `addAuthRefresh`), `pluginStorageStore.svelte.ts`
(`markPluginStorageDirty`); the module defaults still on the client after Phase 3
(`checkNewFormat`'s module steps in `bootstrap.ts`, the `modules` guard in `setDatabase`);
`importModule` (`modules.ts:280-360`, Phase 4 routes it through `addModule`).

Stopping condition: a section or collection whose record cannot be built from the Phase 3 kinds
(a field missing from `SECTION_FIELDS`), or a module default that has no pure form (then it
becomes an import-handling step, as `character-ownership` does for characters).

## Assumptions

- Phase 3 landed as its slices describe (the five section kinds, the twelve collection kinds,
  `translatorPresets` and `hypaV3Presets` as `{ items, selectedId }`, `root` gone,
  `installForwarding` on the raw root, per-kind projections and watchers, `changeToPreset(id)`).
  If Phase 3 ran in its fallback form, `SelectedPreset`/`SelectedPersona` are the records for
  presets and personas and this slice wraps them instead of the accessors.
- Phase 4 (verified against its slices): `collectionStore.svelte.ts` validates and clones every
  value and relies on the section watchers as transport; `pluginStorageStore.svelte.ts` marks
  through `markPluginStorageDirty` and its watcher is gone; `updateSettings` writes a forwarded
  key through the accessor (or the fallback projection) and refuses `llmSecrets` keys.
- Phase 5 made `llmSecrets` write-only: the client holds the masked projection
  (`{ [path]: { set, hint } }` plus the sibling non-secret fields such as `google.projectId`,
  `hordeConfig.model`, `novelai.model`, `vertexRegion`, `vertexClientEmail`) and writes
  credentials through `PUT/DELETE /api/llm-secrets/<path>`; a PUT or batch write carrying a
  masked projection is refused (400).

## Proposed decisions

- Ownership flip (Opus P1 option (a), Astra P7): each section and collection kind becomes a
  write-through record (`records.svelte.ts`, the spike's chosen pattern) held by
  `collectionStore.svelte.ts` under `settings.<kind>`; the raw `DBState.db` root gets one
  enumerable accessor per section and collection field (Phase 3's `installForwarding`, extended)
  whose getter reads `settings.<kind>[field]` and whose setter writes through the record, so
  every unmigrated reader and writer (the `bind:` sites, the registry, the allowlist, the
  plugins) keeps working unchanged while the source of truth is the record. `translatorPresets`
  and `hypaV3Presets` are unpacked by the record into the two `Database` names each. The facade
  is deleted with the object in `aggregate-removal`, once the reader slices are done.
- Transport (proposed): `queueRecordWrite(kind, id)` in `resourceSync.svelte.ts` marks the
  record dirty (the existing `markKey`) and the cycle serializes it from the record at flush
  time; the section, collection, `presets`, `modules`, and `plugins` watchers and the
  `projectCollection` branches are deleted in this slice (invariant 2 for these kinds). The
  cycle, batching, conflict recovery, quarantine, and unload machinery stay. The wire contract
  is unchanged (whole-record ops).
- `llmSecrets` (Astra P6): `settings.llmSecrets` is a read-only status record (masked paths and
  the sibling fields), excluded from `queueRecordWrite` and from any whole-record serialization;
  credentials change only through `setLlmSecret(path, value)`, `clearLlmSecret(path)`, and the
  preset lifecycle routes (Phase 5); a sibling field changes through `updateLlmSecretSiblings(patch)`,
  which sends the record with every masked path omitted (the server keeps the stored value for an
  omitted path; a proposed Phase 5 edit in the report says so explicitly). `llmSecretPresets`
  folds into the status record. The review test edits a sibling field while credentials are set
  and asserts no masked payload enters a batch.
- Module normalization (proposed, a gap in the phase file; Astra P5): the module defaults that
  `checkNewFormat` still applies on the client after Phase 3 are applied by `addModule` and
  `importModule` at creation (Phase 3's approach: the client applies defaults at creation, the
  server normalizer in `normalize/modules.ts` is the backstop, Phase 3's startup pass persists
  its result); no batch result returns data. Obsolete save-layout migrations are dropped.
- `WelcomeRisu.svelte`'s `setPreset(DBState.db, prebuiltPresets.OAI2)` becomes
  `applyPresetTemplate(selection.presetId, template)` on the presets record (the reader slice
  changes the caller; this slice provides the function).
- Snapshot consumers (the settings report, plugin `getDatabase`): unchanged here; they read
  `DBState.db` through the facade until `aggregate-removal` gives them builders.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Review-step tests over
`storeBackedServer.ts`: a write through the facade (`DBState.db.useStreaming = true`) and a
write through a record queue one op with the held revision and no watcher; an idle boot writes
nothing; a conflict reload replaces the record and a later write targets the new one;
`reconcileSelection` after a `presets` replacement; `updateSettings`, `setPersonas`, and
`pluginStorageStore` over the new transport; the `llmSecrets` sibling-field write omits the
masked paths and a batch never carries a masked object; the module normalizer tests; the Phase 3
and Phase 4 test suites unchanged (`resourceSync.test.ts` loses its watcher cases for these
kinds). Manual, recorded here: every settings page still loads and saves (through the facade);
two tabs converge on a settings edit (with `live-updates`). Scoped gate:
`rg -n '\$effect' src/ts/storage/resourceSync.svelte.ts` lists only the character watchers.

## Residual risk

The facade doubles the read path for settings until the reader slices land (an accessor over a
record); the cost is a function call per read. Whole-record writes keep Phase 1's conflict
granularity for sections. The preset and persona accessors (Phase 3) now sit beside section
accessors on the same raw root; `installForwarding` stays idempotent by descriptor check.

## Implementation notes (2026-10-04)

How the implementation departs from the proposed decisions above, after the plan review (Astra,
segment B):

- **No `settings.<kind>` object.** The records live in `src/ts/storage/records.svelte.ts`
  (`trackedRecord(kind)`); `DBState.db`'s accessors are the only public face until the reader
  slices. There is no `readSetting` (amendment), and `queueRecordWrite` is the records module's own
  hook into the adapter's `markKey` (`setRecordWriteListener`), not an export of
  `resourceSync.svelte.ts`.
- **Installation is explicit.** `setDatabaseLite` moves a fresh object's record fields into the
  records (`initializeRecords`, the whole set replaced, nothing queued); `installForwarding` only
  installs accessors and refuses an object that still carries plain record fields.
- **`llmSecrets` siblings** are written through the record like any section field; the record's text
  is the siblings only (as before), so no `updateLlmSecretSiblings` function was needed. Credentials
  written through the record (a flat field, a nested leaf, `OaiCompAPIKeys`, a preset's `proxyKey`,
  a custom model's `key`, also inside an element or list written whole) are routed to the credential
  queue or refused before anything changes.
- **Bulk writers** run in `batchRecordWrites` (one queued write per record): `updateSettings`,
  `setPluginArgument`, the plugin database setters, the plugin storage writers, and the preset switch
  helpers; `addAuthRefresh` and `checkCharOrder` build a plain copy and install it once.
- **Modules.** `normalizeModule` (`shared/modules.ts`) checks the shape (a non-string name or
  description, a non-list lorebook, regex, or trigger is refused, never dropped) and assigns a
  missing id on the client; the server's `normalize/modules.ts` applies the same check and returns a
  valid list unchanged. The old-lorebook conversion (`upgradeLorebook`, what the startup
  `updateLorebooks` step did) runs only on a module file import, with the corrupted-lorebook prompt,
  in `importModule`; the startup copy is gone (alpha). Applying it on every write would rewrite
  entries the MCP tools write.
- **`updateModule`** checks the patched module on a copy and then patches the live module in place,
  so a retained reference (the MCP module tools hold one) stays current.
- **Observable changes:** every declared section field is an enumerable accessor (`in` is true and a
  snapshot lists it, `undefined` when the record lacks it); a retained wrapper follows its record
  across replacements (`db.personas` held before a replacement shows the new list); a plugin
  argument's own `__proto__` key is now saved (the `plugins` projection no longer goes through
  `$state.snapshot`, which dropped it); a credential written to a root field reads back `""`.

- **After the challenge** (Astra, 2026-10-04): an array mutator prepares and unwraps every inserted
  value before it runs (a retained wrapper resolves its current element or throws; nothing changes on
  a refusal); on `presets`/`customModels` the inserted credentials are validated together against the
  list the call leaves (exactly one owner each), `fill` refuses a credential, and a credential is
  routed only for a stored element; `defineProperty` accepts only a plain writable, enumerable,
  configurable data property, checked first; a whole `llmSecrets` replacement carrying a credential is
  refused; `replaceRecordList` counts the elements it drops as displaced; `updatePersona` and
  `updateModule` commit in one batch; a write that creates an absent section record is checked
  before the record is created; `resetRecords` also drops the write listener. Every module import
  path (the module dialog, the `.risum` drop in `App.svelte`, the encoded and shared module links and
  the `.risum` file in `characterCards.ts`, the `.charx` conversion) runs `prepareModuleImport`, which
  refuses an import whose lorebook it cannot read.

### Measurements (the verdict's obligation)

`util/playwright/measureRecords.mjs`, production build, headless Chrome, against a baseline build of
`35678fd4` (the commit before this slice); task latency (to a message-channel callback) unless noted,
median of 10, two or more runs each (the script also prints p95: the preset reorder's is about 18 ms at baseline and 28–30 ms with the records):

| Workload                                                    | Baseline   | Records      |
| ----------------------------------------------------------- | ---------- | ------------ |
| NovelAI image settings mount (the `NAIImgConfig` controls)  | 4.3–4.8 ms | 4.6–4.7 ms   |
| A keystroke into `NAIImgConfig.width`                       | 9.2–9.5 ms | 9.8–10 ms    |
| Preset reorder, 50 presets                                  | 15.3 ms    | 22.2–24.4 ms |
| Module lorebook drag, 300 entries                           | 92–93 ms   | 104–107 ms   |
| The same drag to its completion (the handler's own promise) | 102–104 ms | 113–115 ms   |

Mounting and typing are at parity. Both reorders leave exactly the expected order on the server. The
preset reorder crosses the 16 ms frame and the drag, already six frames at baseline, grows by about
15%. Both handlers change their list in one write (`moveRecordListItem`, `replaceRecordList`, the
verdict's remedy), which did not change the numbers: a profile of the reorder puts the added time in
the list's re-render reading every preset through its wrapper (`resolve`, the wrapper's `get`,
`childWrapper`), the read cost the verdict accepted without the resolve cache.

**Carried forward (not resolved):** the preset list (`botpreset.svelte`) and the module lorebook list
re-render through record wrappers. Moving their readers in the reader slices does not by itself
remove those reads; the reader slice that moves `botpreset.svelte` (slice 6) carries the criterion
that the preset reorder measured by `measureRecords.mjs` is back within 10% of the baseline (16.8 ms
median), by a plain-row projection or keyed rendering, or reports the miss at its stop.

Seen while measuring, not this slice's: since live updates (slice 2), the echo of a tab's own save
schedules a cycle 50 ms later (`noteRemoteChanges`), which sends the edits typed since, so continuous
typing saves about once per keystroke instead of once per 500 ms debounce (the same at baseline).
