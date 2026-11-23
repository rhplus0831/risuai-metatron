# Backups, Realm Hub

## Scope

- Owns:
  - local `.bin` backup export and import (full and partial) and the server snapshot restore button, as client UI over
    the server backup routes,
  - Realm hub browse, terms acceptance, creator blocking, and staged card download,
  - the settings report export.
- Paths:
  - `src/ts/drive/*` (local backup UI and RisuAI-compatible import/export), `shared/backups.ts` (partial archive assets)
  - `src/ts/realmBlocking.ts` (creator block-list rules used by the Realm UI and card entry points)
  - `src/ts/realmTerms.ts` (the RisuRealm terms acceptance every Realm entry point awaits)
  - `src/ts/storage/realmImportClient.ts` (the staged Realm import client)
  - `server/src/data/upstream/` (upstream `.bin` conversion; workers and staging → `server-resources.md`)
  - `shared/{upstreamBackup,upstreamExportReport}.ts` (import/export contracts and reports)
  - `src/lib/UI/Realm/*`
  - `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`
- Not here:
  - The save adapter → [resource sync](resource-sync.md); resources → [persistence](persistence.md).
  - The archive format, snapshots, and the backup routes →
    [server resources](server-resources.md#backup-and-import-internals).
  - Hub URL and card codecs → `characters-modules.md` (`characterCards.ts`).
  - Node `/hub-proxy` → `self-host-server.md`.
  - `localNetwork.ts` → `network-jobs.md`.

## Files

The module headers and export comments hold each module's rules; an entry names the role and the identifiers to look up,
and keeps what spans files.

- `src/ts/drive/backuplocal.ts`: the backup buttons over the server's backup routes (the server builds and reads the
  version-2 archive: [server-resources](server-resources.md)). `SaveLocalBackup`, `SavePartialLocalBackup`
  (`partialBackupFirstConfirm`, `partialBackupSecondConfirm`), `SaveUpstreamLocalBackup`, `LoadLocalBackup`,
  `readFirstRecordName`, `upstreamBackupFileName`.
  - Internals: `downloadArchive`, `streamToFile` (the `LocalWriter` loop both downloads share), `tryReadManifest`,
    `referencedAssets`, `partialAssets`, `reportMissing` (`backupDiscardedChanges`), `backupRefusedNote`
    (`backupRefusedChanges`), `upstreamExportReportText`.
  - Across modules: the flush is `src/ts/storage/resourceSync.svelte.ts` `flushResources` (its `discarded` and `refused`
    keys, the refusal banner's labels); the reload notice keeps its own store in `src/ts/alert.ts` and stays above the
    progress alerts; the partial categories are `shared/backups.ts` `selectPartialBackupAssets`, which the server route
    selects with and this file only labels with.
- `src/ts/drive/upstreamBackupClient.ts`: the client of the upstream import and export routes
  (`server/src/routes/backupsUpstream.ts`, `server/src/routes/backupsUpstreamExport.ts`). Import:
  `prepareUpstreamImport` (through `src/ts/storage/serverImportClient.ts` `importOverServer`), `commitUpstreamImport`
  (`UpstreamCommitOutcome`, `beforeEpochMismatch`; a 412 through `epochMismatch`), `cancelUpstreamImport`,
  `restoreUpstreamBackup`. Export: `tabExportRequest`, `prepareUpstreamExport`, `downloadUpstreamExport`,
  `cancelUpstreamExport`, `UpstreamExportRequestError`.
- `src/lib/Setting/Pages/UpstreamImportReport.svelte` (its file is [settings-i18n](settings-i18n.md)'s): the import
  report dialog, opened by `src/ts/alert.ts` `alertUpstreamImportReport(report, { changedWrites? })` as alert type
  `upstreamImportReport` and rendered by `AlertComp` like the request logs popup; it lists the first 50 missing assets
  (`MISSING_SHOWN`), marking non-`.png` ones as never backed up by RisuAI.
- `shared/upstreamBackup.ts`: the import report and routes. `UpstreamImportReport`, `UpstreamReportEntry`,
  `UpstreamMissingAsset`, `UpstreamAssetReference`, `UpstreamImportSelection`, `addUpstreamReportEntry`,
  `UPSTREAM_REPORT_EXAMPLE_LIMIT`, and the stable codes `UPSTREAM_CONVERTED_CODES`/`UPSTREAM_EXCLUDED_CODES`, which the
  client maps to `language.upstreamImport`.
- `shared/upstreamExportReport.ts`: the export report and routes (`UpstreamExportReport`, `UpstreamExportRequest`),
  codes mapped to `language.upstreamExport`. `shared/backups.ts`: `selectPartialBackupAssets`.
- `src/lib/Setting/Pages/Storage/storageController.svelte.ts` restores a server snapshot and reloads (the Storage page's
  snapshots section; `UserSettings.svelte` links there). `take` flushes this tab's pending saves first, takes no
  snapshot when the flush fails, and names discarded and refused work with the file backup's notes. Snapshot retention,
  validation, and restore ordering are in [server-resources](server-resources.md#snapshots-and-restore); checkpoint
  tables are in its [Checkpoint tables](server-resources.md#checkpoint-tables).
- Realm, the Realm part of `src/ts/characterCards.ts`: `hubURL`, `getRisuHub`, `hubAdditionalHTML`, `hubType`,
  `getRealmInfo`, `showRealmInfoStore`, `downloadRisuHub`, `commitRealmCard`, `getHubResources`; its staged import
  client `src/ts/storage/realmImportClient.ts` (`prepareRealmImport`, `commitRealmImport`, `cancelRealmImport`,
  `cancelRealmImportOnPagehide`, `isRetriableRealmCommitRefusal`).
- `src/ts/realmBlocking.ts` (the creator-id block rules) and `src/ts/realmTerms.ts` (`REALM_TERMS_VERSION`, the RisuAI
  terms and privacy URLs, `ensureRealmTerms`, whose dialog is `src/ts/alert.ts` `alertRealmTerms`).
- `src/lib/UI/Realm/RealmMain.svelte` (browse), `src/lib/UI/Realm/RealmPopUp.svelte` (detail, block, Chat),
  `src/lib/UI/Realm/RealmBlockedCreators.svelte` (the menu's block list), `src/lib/UI/Realm/RealmHubIcon.svelte`,
  `src/lib/UI/Realm/RealmLicense.svelte` (`CCLicenseData`): each states its rules in its `<script>` contract.
- `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`: the redacted settings report (`buildSettingsReport` and
  its complete field projection are in [persistence](persistence.md)), the request logs popup (`alertRequestLogs`,
  [diagnostics](diagnostics.md)), and statistics.
- The `.bin` converters under `server/src/data/upstream/` (their workers and staging are
  [server-resources](server-resources.md)'s):
  - import: `server/src/data/upstream/importDatabase.ts` (`convertUpstreamDatabase`),
    `server/src/data/upstream/importCharacters.ts` (`convertCharacters`),
    `server/src/data/upstream/importCollections.ts` (`convertPluginStorage`),
    `server/src/data/upstream/importRecords.ts`;
  - both directions: `server/src/data/upstream/assetReferences.ts` (`collectUpstreamAssetReferences`,
    `collectAssetReferences`), `server/src/data/upstream/archive.ts` (`planUpstreamArchive`, `readColdRecord`,
    `readColdEntry`, `upstreamAssetRecordName`), `server/src/data/upstream/risuSave.ts` (`decodeUpstreamSave`,
    `encodeUpstreamDatabase`);
  - export: `server/src/data/upstream/exportDatabase.ts` (`buildUpstreamDatabase`, `METATRON_CHAT_FIELDS`).

## Flows

- `src/lib/Setting/Pages/UserSettings.svelte` opens the file backup and restore dialogs, exports datasets, and links to
  the Storage page for server snapshots. `LoadLocalBackup` sends a file with `manifest.json` first to
  `POST /api/backups/import`; other files enter the upstream import flow.
- RisuAI-compatible backup (`SaveUpstreamLocalBackup`, tab → server → tab):
  - After the button's confirmation, "Include API keys?" (`alertConfirm`): without the keys the auxiliary service keys,
    the characters' TTS keys, and the MCP OAuth secrets are blank too, unlike the version-2 archive, which keeps those.
  - `flushResources`, then `prepareUpstreamExport(tabExportRequest(...))`: the server projects one copy of the store
    ([Upstream database export](#upstream-database-export)) with this tab's selection (`settingsViews.svelte.ts`
    `tabSelectionIds`) and open chat (`chatStore.svelte.ts` `currentChatRef`, as `selectedChat`).
  - The report is a confirmation; No cancels the prepared export, yes downloads it (the token is used up) through
    `LocalWriter`. A refusal (409 too many waiting, 413 too large, 404 expired) shows the server's text.
- Upstream RisuAI backup restore (`restoreUpstreamBackup`, tab → server → every tab):
  - The upload and the server's conversion show as a wait alert with the phase and its counts. A refusal (a Risu Account
    backup, a damaged file, a backup too large or over the worker's memory limit, another import waiting) is an
    `alertError` and nothing changes; a 412 reloads.
  - The report dialog's Cancel cancels the prepared import; only its own Restore commits. The server verifies the staged
    file first and reads no row of it. A `409 changedSinceReview`, also for a write that landed during that check, asks
    again with the count of changes saved since the preview (on this or another device; the safety snapshot keeps them),
    and Restore resends with `acceptWrites` set to that count.
  - Before each commit, `resourceSync.svelte.ts` `beforeRestoreReload` registers a synchronous hook that writes the
    prepared selection with `selection.svelte.ts` `persistSelection` when a restore is detected, before the terminal
    notice, which never waits for the commit's answer; a successful answer writes its own selection and reloads.
  - A prepared import not committed is cancelled on the server. Other tabs see the maintenance 503 retries, then the new
    epoch, and reload.
- Realm: `MainMenu` (the Realm card) → `RealmMain` → `getRisuHub` → `RealmPopUp` → `downloadRisuHub`. There is no upload
  path. A block written in the popup reaches `settings.ui.blockedRealmCreators`, which `getRisuHub` and `RealmMain`'s
  reactive filter both apply, so a block from either popup host or another tab hides cards at once; cards without
  creator metadata stay visible.

### RisuRealm terms

- Only RisuRealm's Terms of Service and Privacy Policy gate hub use; the versioned acceptance is stored in shared `ui`
  settings. `RealmMain` gates its first listing and leaves the Realm screen on decline; `getRisuHub`, `getRealmInfo`,
  and `downloadRisuHub` also gate requests. Raising `REALM_TERMS_VERSION` asks again.

### Realm access

- The client refuses blocked creators for URL/id downloads, the popup's Chat button, and `?realm=` details
  (`downloadRisuHub`, `getRealmInfo`), looking a missing creator up first; the server route stages nothing for a card
  the client refused, and does not check the block list itself (`server/src/routes/importRealm.ts`).

### Realm download

- `downloadRisuHub(id)` → `prepareRealmImport` (`POST /api/import/realm`): the server stages a validated PNG or CharX
  card and answers its text and a token; the tab never fetches Realm or holds the file. The tab asks the card's
  questions (`commitRealmCard`), then commits (the server stores the assets and image) or cancels the stage. The stage
  limits (10 minutes, four waiting) and the routes are `shared/realmImport.ts` and `server/src/routes/importRealm.ts`
  ([server-resources](server-resources.md)). Legacy JSON is imported in hub mode, its portrait and assets fetched
  through `/hub-proxy`.
- While a stage waits, a `pagehide` sends its cancel as one `keepalive` request with a `risu-auth` token signed ahead
  (best effort; the TTL stays the fallback). A commit refused as busy (409 `Another import is running`) or in
  maintenance (503 `Maintenance in progress`) is retried once after five seconds; any other refusal cancels the stage.

### Upstream database import

- `server/src/data/upstream/importDatabase.ts` `convertUpstreamDatabase`, a writer of resources: pure and synchronous,
  run in the import worker; its module header and `convertPresets` comment hold the settings, preset, key, and persona
  rules, and `importCharacters.ts` the library's.
- A legacy save's MessagePack-only value (binary, a `Date`, a map or set, an `undefined` array element) in a setting,
  plugin storage value, chat, or message is stored in its JSON form and reported `messagepack-value` (`importRecords.ts`
  `storedValue`/`storedForm`); an `undefined` object property is dropped unreported.

### Upstream library import

- Upstream `.bin` import keeps and normalizes archived groups and retains their chat records. `convertUpstreamDatabase`
  passes only non-group ids to `convertCharacterOrder`. The report labels the count "Group chats (kept, hidden)". See
  [archived groups](characters-modules.md#archived-groups).
- The staged-import writer (`server/src/data/upstream/importStage.ts`) puts the converter's singleton `resources`, then
  its characters, then its chats in batches in array order, so each chat order is upstream's (the hand-off is in
  `importDatabase.ts`'s header).
- Cold storage is folded on import only (the export writes characters and chats inline): stub characters, cold chats
  (`importCharacters.ts` header), and plugin storage (`importCollections.ts` `convertPluginStorage`;
  [Invariants](#invariants)).
- PocketRisu/RisuBard swipes become `candidates` (`message-swipes`; `importCharacters.ts` header): the selected swipe
  plus the newest ring-sized window, so a message with thousands of swipes converts in linear time.

### Upstream database export

- The export worker (`server/src/data/upstream/exportStage.ts`) reads a validated store copy (`readSnapshotFile` of a
  `backupTo` file), `buildUpstreamDatabase` projects it to an upstream flat `Database`, and `encodeUpstreamDatabase`
  writes `database.risudat`; the route then streams the assets by basename and the database last.
- Its settings steps are the job projection's (`server/src/data/databaseProjection.ts`: `projectSections`,
  `projectCollections`, `forwardSelectedPreset`, `forwardPersonaRoots`, `characterShell`, also used by `loadJobScope`).
- `upstreamCharacters` folds the chats' memory switches into the upstream character's `supaMemory`: any enabled chat
  enables it. For Structured Memory, existing HypaV3 summaries take priority. Otherwise the export can write
  [an unsealed projection](structured-memory/projection.md#the-hypav3-projection) from the events (`memory-projected`,
  `memory-unreadable`). The report counts excluded pages and threads (`memory-pages`, `memory-threads`) and the
  confirmation points to the native backup.
- `exportDatabase.ts` holds boot compatibility (`upstreamCharacters`), credentials (`placeNamedKeys`,
  `reportOmittedKeys`), presets and HypaV3 ratios (`upstreamPreset`, module header). Native backups and restores keep
  archived group records and their chats. Upstream export carries the records and active chats.
- Settings upstream's `Database` lacks (`METATRON_ONLY_SETTINGS`, among them `inputHooks`, `requestInterceptions`,
  `moduleFolders`, and `personaFolders`) are deleted from the export, and one that differs from its fresh-boot value is
  reported as excluded `metatron-settings`. An upstream database has neither folder field, so its import leaves both
  `[]`.
- `upstreamPluginStorage` omits `_pluginStorage`, `_safeLocalPluginStorage`, `_ownedPluginStorage`
  (`DEVICE_PLUGIN_STORAGE_KEYS`) from `pluginCustomStorage`, counting their entries as excluded `plugin-storage`; it
  also drops `_coldplugin`. Import still writes legacy `_pluginStorage`, served by owned read-through
  ([plugin storage](plugin-sandbox.md#state)).
- The compatible export includes assets referenced by retained plugin custom values (`collectUpstreamAssetReferences`).
  Native full archives take all stored assets; native partial archives select only the categories in
  `selectPartialBackupAssets`. A file only a plugin's data names is not among them (Decision: owner, 2026-11-20; both
  partial dialogs list plugin files as excluded). Drafts held in a browser have no server backup source
  ([draft recovery](draft-recovery.md)); the Storage page's snapshot section says so (`storage.draftsBackupNote`).
- `upstreamChat` counts omitted translations and reroll candidates as `message-translations` and `message-candidates`.

## State

- `ui.realmTermsAccepted` ([persistence](persistence.md)): the accepted RisuRealm terms version, `""` when none.
- Realm has no account token field (the boot never installs the removed legacy `account` token); old saves may still
  carry an unused character `realmId`.
- UI state: `OpenRealmStore` in `stores.svelte.ts` ([app-shell](app-shell.md)).

## Coupling

- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (`LocalWriter`, fetch), `storage/resourceClient.ts`
  (`exportBackup`, `importBackup`, `listBackups`, `restoreBackup`), `storage/resourceSync.svelte.ts` (`flushResources`,
  `beforeRestoreReload`), `storage/serverImportClient.ts` (`importOverServer`), `storage/selection.svelte.ts`
  (`persistSelection`), `storage/settingsViews.svelte.ts` (`tabSelectionIds`), `storage/chatStore.svelte.ts`
  (`currentChatRef`), `characterCards.ts` (`hubURL` and hub APIs), `alert.ts`, `platform.ts`.

## Invariants

- The archive format (version 2, `manifest.json` first) is defined by the server; the client only streams it and reads
  the manifest.
  - Native archives and snapshots must use the server's current resource schema; the restore validator refuses a
    mismatch. See [server resources](server-resources.md#backup-and-import-internals).
  - Archives in the upstream format (upstream RisuAI and older metatron backups with `database.risudat`) are restored
    through the upstream import under the compatibility rule ([persistence](persistence.md#invariants)): a one-way,
    full-replace migration with a report before anything is replaced.
  - That covers both `database.risudat` encodings, the legacy MessagePack save and the block save current upstream
    backups write (`savekv-namespace` lists every distinct SaveKV namespace without its `kv:` prefix, past the usual
    five-example cap).
  - A live block save whose data lies outside the file (a remote block, or a directory naming a block the file lacks) is
    refused with a message.
  - The version-2 import route still refuses upstream-format archives with a message naming the upstream import.
  - A Risu Account backup (`encryption.risudat`) is refused with a message.
- The upstream import reads plugin storage (`pluginCustomStorage`, converted by
  `server/src/data/upstream/importCollections.ts` `convertPluginStorage` into the `pluginStorage` record, v3 values
  under `_pluginStorage`): preserve the upstream forms and precedence documented on `convertPluginStorage`; cold-record
  classification and selection are documented on `server/src/data/upstream/archive.ts` `readColdRecord`/`readColdEntry`.
  The prepared import commits as a staged full replacement ([server-resources](server-resources.md#upstream-backups)).
- A backup restore replaces every resource and installs assets under
  [the content-name rule](server-resources.md#backup-and-import-internals) (`server/src/routes/backups.ts`
  `restoreValidated`); the app reloads afterwards because every revision the tab held is void (new epoch).
- Validation failures, including the server's restore memory limit (`RISU_RESTORE_HEAP_MB`), precede maintenance. They
  leave running jobs alone and take no safety snapshot. The tab shows the route's `error` text.
- Full version-2 archives carry private data, including `googleSearchCredentials`, the Iris dialogue, plugin storage,
  and the plugin permission grants.

## Recipes

- Add a partial-backup asset category: `selectPartialBackupAssets` in `shared/backups.ts`, its labels and inventory
  mapping in `backuplocal.ts` `partialAssets`, and the staged-resource query in `server/src/data/exportScrub/worker.ts`
  if another kind is needed (a full backup already takes every asset).
- Change the archive format: the server side (see `server-resources.md`) and `tryReadManifest` here. Add a round-trip
  test.
- Change what the RisuAI-compatible backup carries: the projection is `exportDatabase.ts`
  ([Upstream database export](#upstream-database-export); metatron-only chat fields go in `METATRON_CHAT_FIELDS`); a new
  report code goes into `shared/upstreamExportReport.ts` and `language.upstreamExport` (`en.ts`, `ko.ts`). The record
  layout (assets by basename, then `database.risudat`) is upstream's restore format: keep `upstreamAssetRecordName` in
  step with `planUpstreamArchive`, so this app's own import reads every export back.
- Change Realm: `characterCards.ts` hub functions and the matching `Realm*` component together. Check `hubURL` on Node
  (`/hub-proxy`).

## Tests

- Client/Realm tests:
  `pnpm --silent test:agent src/ts/drive src/ts/alertUpstreamImportReport.test.ts src/ts/characterCardsRealmImport.test.ts src/ts/realmBlocking.test.ts src/lib/UI/Realm/RealmMain.test.ts shared/tests/backups.test.ts`.
- Upstream conversion tests:
  `pnpm --silent test:agent server/src/tests/{upstreamArchive,upstreamRisuSave,upstreamImportReport,upstreamImportSettings,upstreamImportCharacters,upstreamImportRoute,upstreamExport,upstreamExportRoute}.test.ts`.
- `slow`:
  `pnpm --silent test:agent --tags-filter=slow server/src/tests/{upstreamImportWorker,upstreamExportWorker}.test.ts`;
  these exercise cold worker boots and heap limits.
- The additional tagged import check in `upstreamImportCharacters.test.ts` follows
  [Slow-test table](test-harness.md#slow-test-table); include it when changing `importCharacters.ts` or
  `importRecords.ts`.
- Backup tests fake `authFetch`, `LocalWriter` and resource flushes; the snapshot test runs the real export route, Realm
  tests local server/Realm stand-ins, the report dialog and restore-selection hooks alert and storage fakes.
- Manual compatibility check: `util/upstream/checkBinCompat.mjs` runs upstream's decoder/defaults against pinned
  `legacy` or `current` targets; `--bin` checks an existing export. The `current` target also runs upstream's plugin
  storage migration ([build/test platforms](build-test-platforms.md#files)).
- Settings-report redaction: `pnpm --silent test:agent src/ts/storage/tests/snapshots.test.ts` (`buildSettingsReport`).
- Snapshot flush and refusal notes: `pnpm --silent test:agent src/lib/Setting/Pages/Storage/storageController.test.ts`.
- Not tested: terms-dialog rendering, `RealmMain` leaving on decline, `LocalWriter`/streamSaver integration, and a
  backup restored in upstream's own app. There is no dedicated e2e spec for this area; the compatibility script does not
  run upstream's `LoadLocalBackup` UI. `upstreamBackupClient.ts` `tabExportRequest` including the open chat as
  `selectedChat` is also untested; `backuplocal.test.ts` exports from home.
- Not tested: `importDatabase.ts` `convertPresets` rethrowing an unexpected error rather than treating it as a
  `ResourceValidationError`; `upstreamImportSettings.test.ts` exercises validation refusals.

## Known Hazards

### Limitations

- Kept tab-side or unbounded in the Realm import (2026-11-09, Found Issues Clearance B5): a legacy JSON card's hub
  resources are fetched by the tab (`characterCards.ts` `getHubResources`) without retry, so a transient fetch failure
  ends the import; a CharX card's embedded `module.risum` is read in the tab (`readModule`), which stores its assets;
  `planPngFile` (`server/src/routes/importPng.ts`) reads one key prefix per tEXt chunk. Decision: Large Asset Import and
  Export, kept limits, [archive](../archived-plan/README.md).
- Without keys, `exportDatabase.ts` `clearAuxiliaryKeys` writes `authRefreshes: []` even when the field is absent;
  absence is not preserved in the upstream export. Decision: Upstream .bin Compatibility S6,
  [archive](../archived-plan/README.md).
- In `exportDatabase.ts` `placeNamedKeys`, a chosen slot whose named credential no longer exists leaves its upstream
  field unreserved, so a later slot can fill it with a different key. Decision: Upstream .bin Compatibility S6,
  [archive](../archived-plan/README.md).
- `importDatabase.ts` `convertPresets` reports a repaired model-profile reference as `modelPresets[<generated id>]`, so
  an invalid-setting example can contain an opaque id rather than a preset name. Decision: Upstream .bin Compatibility
  S3, [archive](../archived-plan/README.md).
- The RisuRealm terms gate is client-side only: `GET /hub-proxy/*` (unauthenticated) and `POST /api/import/realm` do not
  check `ui.realmTermsAccepted`. Decision: owner, 2026-11-10 (known-issues review): the gate is a notice to the server's
  owner, not a security boundary.
