# Backups, Realm Hub

## Scope

- Owns:
  - local `.bin` backup export and import (full and partial) and the server snapshot restore button, as client UI over the server backup routes,
  - Realm hub browse and download (upload, report, and remove were removed),
  - the settings report export.
- Paths:
  - `src/ts/drive/backuplocal.ts` (the folder name is historical; Google Drive sync, Risu Account sync, and Kei auto-backup were removed)
  - `src/lib/UI/Realm/*`
  - `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`
- Not here:
  - The save adapter and resources → `persistence.md`.
  - The archive format, snapshots, and the backup routes → `self-host-server.md`.
  - Hub URL and card codecs → `characters-modules.md` (`characterCards.ts`).
  - Node `/hub-proxy` → `self-host-server.md`.
  - `localNetwork.ts` → `global-api.md`.

## Files

- `drive/backuplocal.ts` (the server builds and reads the archive; see `self-host-server.md`):
  - `SaveLocalBackup`: `flushResources`, then `POST /api/backups/export` (every asset on the server, inlays included, plus a snapshot of the resources), streamed to a file through `LocalWriter.write`. The manifest (first record) is read from the stream head; assets the database references but the archive lacks are reported. When the pre-backup flush replaced a local change (`flushResources`' `discarded` is non-empty: another writer's version is what the archive holds), the success alert or the missing-asset report says so (`backupDiscardedChanges`); the reload notice, in its own store, also stays above the progress alerts.
  - `SavePartialLocalBackup`: the same with `{ partial: true }`; the server selects character/group profile images, persona icons (including the selected user icon), background, folder images, and preset images from the resource snapshot it archives (no inlays, emotion images, additional assets, VITS, or CC assets). `shared/backups.ts` `selectPartialBackupAssets` defines these categories for both sides; the client's `partialAssets` uses it only to label the manifest's `missing` entries. A key absent from the client's inventory is reported as "Unknown Asset".
  - `LoadLocalBackup`: posts the chosen `File` to `POST /api/backups/import` and reloads. The server refuses Risu Account archives (`encryption.risudat`) and archives from before Phase 1 (`database.risudat`, no migration owed).
- `globalApi.svelte.ts` `loadInternalBackup` ("Load Internal Backup" in `UserSettings.svelte`): lists the server snapshots (taken every 10 minutes while data changes, 20 kept), restores the chosen one, reloads.
- `UI/Realm/RealmMain.svelte`: browse via `characterCards.ts:getRisuHub`.
- `RealmPopUp.svelte`: detail, copy link, and `downloadRisuHub`.
- `RealmHubIcon.svelte`, `RealmLicense.svelte` (`CCLicenseData`).
- `SettingsExportButtons.svelte`: a redacted settings report (strips characters, keys, `irisDialogue`, `googleSearchCredentials`, and `pluginCustomStorage`), the request logs popup (`alertRequestLogs`, `global-api.md`), and statistics.

## Flows

- Entry points:
  - `UserSettings.svelte`: local backup buttons, internal backup restore, dataset export.
- PeerJS multiuser chat (rooms, peer sync, and the `peerjs` dependency) was removed.
- Realm: `MainMenu` (the Explore card) → `RealmMain` → `getRisuHub(search, page, nsfw, sort)` → `RealmPopUp` → `downloadRisuHub`. There is no upload path.
- Realm download: `downloadRisuHub(id)` asks the server to download and stage the card (`prepareRealmImport`, `POST /api/import/realm`, `storage/realmImportClient.ts`, `self-host-server.md`); the tab never fetches realm.risuai.net or holds the file. The server validates a CharX or PNG card, writes nothing, and answers its card text (a CharX file's embedded `module.risum` too) and a token. The tab then reads the card and asks its questions (`commitRealmCard` in `characterCards.ts`): an `rcc` card's password (decrypted in the tab, `readPngCard`) and the `lowLevelAccess` confirmation (`confirmCardLowLevelAccess`). A card that is declined, has a wrong password, or fails to read is cancelled (`cancelRealmImport`, `POST /api/import/realm/cancel`), so nothing is stored; otherwise the tab commits (`commitRealmImport`, `POST /api/import/realm/commit`), the server stores the assets and the image and answers their keys, and the tab builds the character (`importCharxCard`/`importPngCharacter`, the question not asked again). A commit that fails is cancelled too (404 `Import expired` after 10 minutes is `realmImportExpired`; a prepare refused while 4 imports wait is `realmImportTooManyWaiting`). A legacy JSON answer is passed through and imported in hub mode as before (its portrait and hub-mode assets fetched through `/hub-proxy`).

## State

- DB: `localNetworkMode`, `localNetworkTimeoutSec`. The removed legacy `account` token is no record field (the boot never installs it); old saves may still carry an unused character `realmId`.
- Stores: `OpenRealmStore`.

## Coupling

- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (`LocalWriter`, fetch), `storage/resourceClient.ts` (`exportBackup`, `importBackup`, `listBackups`, `restoreBackup`), `storage/resourceSync.svelte.ts` (`flushResources`), `characterCards.ts` (`hubURL` and hub APIs), `alert.ts`, `platform.ts`.

## Invariants

- The archive format (version 2, `manifest.json` first) is defined by the server; the client only streams it and reads the manifest. Archives made before Phase 1 are not restorable, and neither is an archive or snapshot whose resource database has another schema version than the server's (3 since Phase 3): the server refuses it with a message, and no migration is owed.
- Export, change, and restore are covered end to end on a version-3 store (Phase 4 closeout): an archive import undoes changes made after the export (a plugin `setCharacter`, an MCP tool), and restoring the safety snapshot the import took brings them back.
- A backup restore replaces every resource and only adds assets that do not exist yet; the app reloads afterwards because every revision the tab held is void (new epoch).
- Private backups carry everything, including `googleSearchCredentials`, the Iris dialogue, plugin storage, and the plugin permission grants.
- `getLocalNetworkRequestOptions` must stay paired with `isLocalNetworkUrl`. Browsers reject the local route.

## Recipes

- Add a partial-backup asset category: `selectPartialBackupAssets` in `shared/backups.ts`, its labels and inventory mapping in `backuplocal.ts` `partialAssets`, and the staged-resource query in `server/src/routes/backups.ts` if another kind is needed (a full backup already takes every asset).
- Change the archive format: the server side (see `self-host-server.md`) and `tryReadManifest` here. Add a round-trip test.
- Change Realm: `characterCards.ts` hub functions and the matching `Realm*` component together. Check `hubURL` on Node (`/hub-proxy`).

## Tests

- `src/ts/drive/backuplocal.test.ts`: over a fake `authFetch` and a fake `LocalWriter`: the flush before an export, the archive streamed to the file with the manifest read across chunk boundaries, the missing-asset report by character and role, no export when the flush fails, response cancelled when the writer cannot open, stream cancelled and writer aborted on a write failure, writer aborted on a broken download, a refused export reported; a non-empty `discarded` from the flush named in the success alert and ahead of the missing-asset report (full and partial); the partial backup's two confirmations and missing-asset labels; `LoadLocalBackup` posting the file with the epoch header and reloading, the server's refusal shown, and a 412 reloading without an error.
- `src/ts/drive/backuplocalSnapshot.test.ts`: `SavePartialLocalBackup` against the real export route (node environment, the flush stubbed): an image another writer commits while the client waits for its flush is in the archive and its resource snapshot, and a referenced image the server lacks is reported under the character's label. `shared/tests/backups.test.ts`: the selector's categories, deduplication, and what it ignores.
- Adjacent: `src/ts/network/localNetwork.test.ts`.
- Not tested: `LocalWriter` itself (streamSaver), Realm, settings redaction.

## Known Hazards

- `RealmMain` renders `hubAdditionalHTML` via `{@html}`.
