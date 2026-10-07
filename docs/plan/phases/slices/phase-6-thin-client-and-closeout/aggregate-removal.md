# Slice: Aggregate Removal

Status: implemented (2026-10-07; the whole-database aggregate removed, the records as the only client model).

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Accessors" (the live
`getDatabase()` removed; `setDatabase`, `setDatabaseLite`, `setCurrentCharacter`,
`setCharacterByIndex` removed), "Selection shims" (the Phase 3 forwarding layer and the derived
`botPresetsId`, `selectedPersona`, `loreBookPage` removed with the facade), "Save loop" (`saveDb`
deleted), "Server storage" (`NodeStorage` split into asset access and auth), the Safety
Contract measurement (the reference counts reach zero), and the exit criterion "`rg 'DBState\.db'`
outside the projection modules returns nothing"; `PLAN.md` Closeout Criteria ("No production
code reads `getDatabase()` for a live object, and no client code encodes a save file"),
invariant 6 (persisted keys are never renamed in the shared formats and in the compatibility
projection).

Depends on: `readers-settings-pages`, `readers-settings-consumers`, `readers-characters`,
`chat-projection-and-lazy-loading` (every reader moved), `live-updates`.

## Scope

Allowed files: `src/ts/stores.svelte.ts` (`DBState` deleted), `src/ts/storage/forwarding.svelte.ts`
(deleted: the Phase 3 accessors, the three derived shims, and the Phase 6 facade),
`src/ts/storage/database.svelte.ts` (`getDatabase`, `setDatabase`, `setDatabaseLite`,
`getCurrentCharacter`, `getCurrentChat`, `setCurrentCharacter`, `setCharacterByIndex`,
`getCharacterByIndex`, `replaceCharacterFields` deleted; `saveImage`, `appVer` stay; the preset
functions move to `collectionStore.svelte.ts` or a `presets.svelte.ts`), `src/ts/storage/snapshots.svelte.ts`
(new: `buildDatabaseSubset`, `buildSettingsReport`, `buildBackupInventory`; `.svelte.ts`
because it snapshots `$state` records, STRUCTURE T3, or a JSON clone in a plain `.ts`: Opus
P14), `src/ts/storage/resourceSync.svelte.ts` (the `DBState` import, `projectCollection`,
`projectRecord`'s mirror reads, `applyToMirror`'s mirror writes, `excludedRootKeys` gone; the
name stays), `src/ts/globalApi.svelte.ts` (`saveDb` deleted; `forageStorage` replaced by the
asset client), `src/ts/storage/nodeStorage.ts` (split into `src/ts/storage/assetClient.ts`:
`readAsset`, `writeAsset`, `listAssets`, `removeAssets`; and `src/ts/storage/serverAuth.ts`:
`authFetch`, `getNodeServerProxyAuth`, `ensureAuth`, `digestPassword`, the key pair),
`src/ts/storage/autoStorage.ts` (deleted; its test deleted in the review step), `src/ts/bootstrap.ts`
(`loadData` boots the modules; `assembleDatabase`, `setDatabase`, `checkNewFormat`, `assignIds`
gone), `src/ts/process/files/inlays.ts` (the asset client), `src/ts/characterCards.ts`
(`exportChar` over a character record plus `readChatsDetached`), `src/ts/storage/exportAsDataset.ts`,
`src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`, `src/ts/drive/backuplocal.ts`
(`referencedAssets`, `partialAssets` over the inventory builder), `src/ts/util.ts` (`getEmotion`
over the selected character), `src/lib/Others/GridCatalog.svelte` (`formatChars` over
`characterList`), `src/ts/process/templates/templateCheck.ts` (`templateCheck(promptTemplate)`),
`src/ts/plugins/apiV3/v3.svelte.ts` (host `getDatabase` over `buildDatabaseSubset`; the host
functions keep their names), `src/ts/plugins/plugins.svelte.ts`, `shared/database.ts`
(`Database` becomes a type-level composition of the section, collection, and character shapes),
`src/App.svelte`, `src/lang/en.ts`, and every file `rg -n 'DBState\.db' src` still lists at the
start of this slice. Tests belong to the review step.

Identifiers (verified 2026-09-30; matching lines, tests excluded): `DBState`
(`stores.svelte.ts:95-97`); 1,917 matching lines in 118 files today (2,161 occurrences);
`getDatabase` (`database.svelte.ts:753-758`; 224 lines in 55 files, 3 with `snapshot: true`:
`characterCards.ts:575`, `persona.ts:55`, `SettingsExportButtons.svelte:38`; the count includes
the definition, re-exports, and the plugin host function name, so it is discovery, not the gate),
`setDatabase` (38-743; callers `bootstrap.ts:50, 411`; `request/google.ts:516` Phase 5 removes;
`v3.svelte.ts:903` Phase 4 removes), `setDatabaseLite` (745-747; callers `database.svelte.ts:742`;
`plugins.svelte.ts:370` Phase 4 removes), `saveDb` (`globalApi.svelte.ts:205-213`; caller
`bootstrap.ts:94`), `startResourceSync` (`resourceSync.svelte.ts:1173-1296`); the whole-shape
consumers: plugin host `getDatabase` (`v3.svelte.ts:1059-1073`: `allowedDbKeys`, 23 keys,
returns a partial `DatabaseSubset`; `includeOnly` defaults to `"all"`), `DatabaseSubset`
(`risuai.d.ts:372-420`, lacks `selectedPersona` and `characterOrder`, pre-existing),
`exportAsDataset.ts:6-24`, the settings report (`SettingsExportButtons.svelte:34-99`: a snapshot
minus 35 named fields and every key containing `key`, `proxy`, or `hypa`), `exportChar`
(`characterCards.ts:574-606`), `matcherArg.db` and `CBSRegisterArg.getDatabase` (`cbs.ts:70, 116`;
Phase 5 slice 3 feeds them a frozen read model), `risuChatParser(db?)` (`parser.svelte.ts:1672-1712`),
`templateCheck(db)` (`templateCheck.ts:3-76`, reads `promptTemplate` only; caller
`PromptSettings.svelte:43-45`), `referencedAssets`/`partialAssets` (`backuplocal.ts:19-98`),
`getEmotion(db)` (`util.ts:241-310`), `formatChars(db)` (`GridCatalog.svelte:21-50`),
`IrisModal.svelte`. `NodeStorage` (`nodeStorage.ts:5-226`: `setItem` `/api/write`, `getItem`
`/api/read`, `keys` `/api/list`, `removeItem` `/api/remove`, `createAuth`, `getProxyAuth`,
`ensureAuth`, `checkAuth`, `login`, `digestPassword`), `authFetch` (235; callers
`resourceClient.ts:91`, `inlays.ts:485`), `getNodeServerProxyAuth` (230; callers
`globalApi.svelte.ts:506, 873, 1135`, `resourceClient.ts:224`), `AutoStorage` (callers
`globalApi.svelte.ts:112, 137, 164, 191, 202`, `inlays.ts:161, 229, 512`, `bootstrap.ts:41`),
`forageStorage` (`globalApi.svelte.ts:42`); `nodeStorage.test.ts`, `autoStorage.test.ts`. The
plugin API declarations that keep the names `getDatabase`, `setDatabase`, `setDatabaseLite`
(`risuai.d.ts:1492, 1504`, `plugins.md`).

Stopping condition: a `DBState.db` reader left by the reader slices that has no projection to
read from (a missed screen), or a consumer that needs a field no record holds (a dropped field);
recorded and reported, not re-added as an aggregate field.

## Assumptions

- The reader slices moved every reader they own; at this slice's start `rg -n 'DBState\.db' src`
  lists only `stores.svelte.ts`, `forwarding.svelte.ts`, `database.svelte.ts`,
  `resourceSync.svelte.ts`, the snapshot consumers named above, and stragglers this slice owns.
- Phase 4 (verified): `v3.svelte.ts:903` and `plugins.svelte.ts:370` are gone; the host
  `setDatabase`/`setDatabaseLite` route per key through the modules; the plugin `getDatabase`
  reads forwarded keys through `readSetting`.
- Phase 5 removed the client processing layer's live reads (`cbs.ts`, `request/`,
  `scriptings.ts`, `triggers.ts`, `index.svelte.ts`'s body); the client CBS wrapper takes a read
  model built from the records (Phase 5 slice 3).
- Phase 3's `setDatabase` keeps only the legacy deletions, the Phase 1 guards, and
  `changeLanguage`; the character and module defaults are applied at creation by the modules
  (`character-ownership`, `settings-ownership`), so nothing on the client normalizes a record at
  boot.
- The plugin API surface is unchanged (Non-Goals): `getDatabase()` still answers a
  `DatabaseSubset` with the 23 `allowedDbKeys`; `characters` in it carries chats through
  `readChatsDetached`.

## Proposed decisions

- Snapshot builders (proposed): `buildDatabaseSubset(keys)` assembles the plugin subset from the
  settings records, `characterRecords` with chats from `readChatsDetached` (a one-off server
  read when `characters` is requested), and `selection`; `buildSettingsReport()` assembles the
  report from the section records with the same redaction rules (the 35-field list becomes
  "every section except `secrets`, `llmSecrets`, `irisDialogue`, `googleSearchCredentials`, and
  the collections the report already dropped"); `buildBackupInventory()` gives `backuplocal.ts`
  the asset references. Each returns a fresh plain object; none is reactive, cached, or written
  back, so none is "an aggregate under another name" (Safety Contract; invariant 6 keeps the
  field names inside them).
- `Database` type (proposed): kept in `shared/database.ts` as a type alias composed from the
  section, collection, and character shapes, because `.risup` import and export, the plugin
  `DatabaseSubset`, and the report builder type against it. No runtime value of the whole type
  exists on the client after this slice.
- Accessors (decided by the phase file): `getDatabase()` is deleted with `DBState`;
  `getCurrentCharacter()` and `getCurrentChat()` are deleted when their callers are gone (the
  type check lists them); `setDatabase`, `setDatabaseLite`, and the Phase 4 wrappers
  `setCurrentCharacter`/`setCharacterByIndex` are deleted; `changeLanguage(settings.ui.language)`
  runs from `loadData`. `forwarding.svelte.ts` is deleted whole: the Phase 3 preset and persona
  accessors, the three derived shims, and the Phase 6 facade go together; `selectedCharID` and
  `selIdState` are deleted if their references reached zero in the reader slices, else kept as
  derived stores over `selection.characterId` (recorded; U4 updated either way in the closeout).
- Save loop (decided by the phase file): `saveDb` is deleted; `startResourceSync` is called from
  `loadData` and installs no `$effect`. The remaining reactive readers (`App.svelte`'s
  `didFirstSetup`, the chat-fold effects, the `moduleUpdate` effect, `CustomCSSStore`) read the
  records; the `supaMemory` selection write was routed in `character-ownership`.
- `NodeStorage` (decided by the phase file, "or folded into the resource client"; split
  proposed): assets stay their own client (`assetClient.ts`, the four routes, unchanged wire
  contract) and the auth helpers move to `serverAuth.ts`, imported by `resourceClient.ts`,
  `assetClient.ts`, `inlays.ts`, and the proxy callers in `globalApi.svelte.ts`. `AutoStorage`
  and `forageStorage` are deleted (one backend since Phase 1). Alternative (fold assets into
  `resourceClient.ts`): rejected, assets are bytes under another route family with separate
  tests.
- Boot (proposed): `loadData` reads every kind with chat summaries, seeds the queue's
  `persisted`, and calls each module's `assemble` (settings, characters, chats, inlays), then
  `loadSelection()`, the theme functions, `startResourceSync()`, `connectEventFeed()`,
  `importBrowserLocalData`, plugins, `loadedStore`. `assignIds` is gone (ids are assigned at
  creation since Phases 2 and 3).
- Exit measurement (decided by the phase file): the opening-baseline rows are re-measured with
  the same commands (matching lines, tests excluded) and recorded in the phase file: `DBState.db`
  references, two-way `bind:` onto it, direct assignments (the spike's regex), and live
  `getDatabase()` callers, all zero outside `risuai.d.ts` and the plugin docs; `selectedCharID`
  reported alongside.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`; the audit greps (Astra P11, Opus
P12): `rg -n 'DBState' src --glob '!src/ts/plugins/apiV3/risuai.d.ts'` empty;
`rg -n 'getDatabase\(|setDatabaseLite\(|setDatabase\(|saveDb|forageStorage|AutoStorage|NodeStorage' src --glob '!src/ts/plugins/apiV3/risuai.d.ts' --glob '!*.test.ts' --glob '!**/tests/**'`
lists only the plugin host function names in `v3.svelte.ts` (the API surface) and the snapshot
builders; `rg -n 'RisuSaveEncoder|RisuSaveDecoder' src` empty (the save codec specifically, not
`encode(`). Review-step tests: the snapshot builders (the plugin subset equals the old
`getDatabase` shape for the 23 keys over a fixture, chats included; the report redaction; the
backup inventory), `assetClient` and `serverAuth` tests carried over from `nodeStorage.test.ts`,
the boot sequence over `storeBackedServer.ts` (no echo write on an idle boot, every module
assembled). Manual, recorded in the phase file: first run on a fresh server, every screen, a
plugin using `getDatabase` and `setDatabase`, the settings report, a dataset export, a backup
export and import, a card export; an idle reload writes nothing; Docker smoke.

## Residual risk

The plugin `getDatabase()` with `characters` reads every chat from the server on each call
(compatibility over cost; documented in `plugins.md`). `Database` survives as a type alias with
no runtime instance. The `selectedCharID` shim's fate is decided here, not gated.

## Implementation notes (2026-10-07)

The allowlist was recomputed at the slice's start: the Stop C entry in `implementation-plan.md` lists every remaining site. Of the consumers the spec named, `exportAsDataset`, `exportChar`, `formatChars`, `getEmotion`, `templateCheck` and `IrisModal` already read the records (slices 6 to 9b), so they needed no change.

- **The aggregate.**
  - `DBState`, `selectedCharID` and `selIdState` are deleted from `stores.svelte.ts`, and `selection.svelte.ts` loses its index store.
  - `forwarding.svelte.ts` is deleted whole. Its rules (the read fallback, untracked writes, a dropped write when the selection names nothing) moved to `settingsViews.svelte.ts` over the records:
    - `presetRecordForWrite` and `personaRecordForWrite`;
    - `selectedPresetIndex` and `selectedPersonaIndex`;
    - `reconcileSelection()`;
    - `hasPreset`, `readPresetFieldOf`, `writePresetField` and `forwardedPresetField`;
    - `SETTINGS_ROOT_KEYS`.
  - `records.svelte.ts` loses `assignCharacters`, the facade's `characters` setter. Its list guards stay. `characterStore`'s list reads `trackedCharacters()`.
- **The accessors.**
  - `database.svelte.ts` keeps only the version, the type re-exports, the defaults, `saveImage` and `defaultSdDataFunc`.
  - The preset actions moved to `presets.svelte.ts` over `settings.providers` and `settings.presets`.
- **Boot.**
  - `installBootRecords` installs the records straight from the snapshot: the required records strictly, `modules` and `plugins` as `[]` when absent, and `pluginStorage` when present. Then it resolves the selection and sets the language.
  - `maintainCharacters` prunes the trash and repairs the order.
  - `startResourceSync` is called from `loadData`. `saveDb` and `forageStorage.Init` are gone.
- **CBS.**
  - `CbsDatabase` (`shared/cbs/types.ts`) narrows the host's database to the ten fields shared CBS reads.
  - The client host serves them from frozen getters over the records: `readSettingsRoot`, and `characterList()`, whose wrappers keep the chat module's compatibility `chats`/`chatPage` view.
  - The scoped host checks its captured preset and persona on every parse, then reads the preset fields from that preset.
  - The selected index is read untracked, as the store it replaces was.
- **Snapshots.** `snapshots.svelte.ts` provides:
  - `rootSnapshot` (every root name, `proxyKey: ""` and the three selection indexes, cloned per value);
  - `buildDatabaseSubset` (the plugin `getDatabase`);
  - `buildSettingsReport` (the report and its redaction);
  - `buildBackupInventory`.

  `DatabaseSubset` in `risuai.d.ts` now declares `selectedPersona` and `characterOrder`.

- **Storage.**
  - `serverAuth.ts` holds one auth state for the tab, where `NodeStorage` used two: the asset backend's and the resource client's.
  - `assetClient.ts` has `readAsset` and `writeAsset` with the old wire behavior.
  - `nodeStorage.ts`, `autoStorage.ts` and `forageStorage` are deleted, and every importer was repointed.
- **Tools and docs.**
  - The `util/playwright` scripts that drive the current tree read and write through the views.
  - `capturePhase3Fixtures.mjs` and `capturePhase5Baseline.mjs` capture their own baseline commits and are left unchanged.
  - `STRUCTURE.md` and the guides were corrected where they named a removed module as current; slice 11 rewrites the guides.

### Plan review

Astra raised nine points, and all were adopted (the plan's "Decisions"):

1. `checkLiveUpdates.mjs` and the e2e specs to adapt are named.
2. The snapshot values are cloned per value, keeping `undefined`.
3. `rootSnapshot` keeps `proxyKey: ""` for the boot oracle.
4. The backup inventory is a detached, chat-free asset shape.
5. The scoped CBS host checks its targets eagerly.
6. Only `assignCharacters` and the index store go; the list guards and the selection hook stay.
7. The asset and auth contracts are kept exactly.
8. The strict boot checks and the boot order are kept, and so is `checkCharOrder` after the pruning.
9. The `DBState` gate is literal, and the test manifest is exact.

### After the challenge

Astra found one gap: the planned `DatabaseSubset` declaration fix was missing. It is fixed. No runtime regression was found in the selection rules, the list guards, module initialization, reactivity, CBS, the boot writes, the preset actions, the snapshots, the report (34 distinct redacted keys, as before), auth and assets, or the removed-symbol audit.

### Deviations

- **`Database` stays the flat interface in `shared/database.ts`**, not a type-level composition. The server's job projection, the normalizers, `shared/resources.ts` and the section maps use it. A composition with the same keys changes nothing at runtime, and the client holds no value of the whole type.
- **The plugin `getDatabase` keeps the 9a/9b mechanism** (load and pin the chats, then one synchronous pass), not `readChatsDetached`.
- **The records' character chat view stays**, because shared CBS reads `character.chats`.
- **A leftover `pluginCustomStorage._coldplugin` key is kept as data.** The client no longer deletes it at boot: this is an alpha with no migration owed. An old boot could have written a cleanup.
- **The preset and persona backstop (`normalizePresets`/`normalizePersonas`) is gone from the client.** The server normalizes and materializes both.
- **The `ReloadGUIPointer` subscriber in `stores.svelte.ts` skips its first, synchronous call** (found by the test adapter). `stores.svelte.ts` and `transformClient.ts` import each other, and that first call reached `resetTransformEffects` while `stores.svelte.ts` was still evaluating: when `transformClient` was evaluated first, its `appliedEmotions` set was not initialized yet. The app always loaded `stores.svelte` first, and the aggregate's imports hid the order in `pluginContext.test.ts`. The skipped call had nothing to reset: the set was empty and the chat pointer had no subscribers.

### Tests

The Fable test adapter adapted 86 test files and retired 2:

- `autoStorage.test.ts` and `database.setDatabase.test.ts` (backend selection and the boot cleanups, both removed).
- `nodeStorage.test.ts` split into `serverAuth.test.ts` and `assetClient.test.ts`.
- `forwarding.test.ts` and `forwardingPersonas.test.ts` moved to the views as `presetViews.test.ts` and `personaViews.test.ts`.
- The cases that pinned removed paths were retired, with the reason recorded for each: accessor installation, the boot re-installation, `assignCharacters`, the store shims, and the client preset normalization.

### Review

Fable reviewed the slice and found no problem: the selection rules, the boot, CBS, the plugin host, the snapshots, auth and assets, the audit, the `stores.svelte.ts` deviation, and the adapted assertions. It wrote two test files:

- `snapshots.test.ts` (11 cases): the snapshot builders and the report redaction, which had no direct test.
- `stores.importOrder.test.ts` (2 cases): the import cycle, in both orders.

It judged Astra's manual checks covered by the e2e specs, the Docker smoke and `checkLiveUpdates`.
