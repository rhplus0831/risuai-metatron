# Slice: Aggregate Removal

Status: planned (drafted 2026-09-30, refined after review, not started).

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
