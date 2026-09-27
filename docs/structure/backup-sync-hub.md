# Backups, Cloud Sync, Multiuser, Realm Hub

## Scope
- Owns:
  - local `.bin` backup export and import (full and partial),
  - Google Drive backup and restore,
  - Risu Account data and backups,
  - Kei server auto-backup,
  - PeerJS multiuser chat sync,
  - Realm hub browse, download, and upload,
  - the settings report export.
- Paths:
  - `src/ts/drive/{backuplocal,drive,accounter}.ts`
  - `src/ts/kei/{kei,backup}.ts`
  - `src/ts/sync/multiuser.ts`
  - `src/ts/realm.ts`
  - `src/lib/UI/Realm/*`
  - `src/lib/Setting/Pages/FilesSettings.svelte`
  - `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`
  - `public/functions/drive.js`
- Not here:
  - The save format and backends → `persistence.md`.
  - Hub URL and card codecs → `characters-modules.md` (`characterCards.ts`).
  - Node `/hub-proxy` → `self-host-server.md`.
  - `localNetwork.ts`/`proxyJobWs.ts` → `global-api.md`.

## Files
- `drive/backuplocal.ts`:
  - `SaveLocalBackup`: all assets, cold-storage payloads, and `database.risudat` (legacy compressed DB without `account`).
  - `SavePartialLocalBackup`: profile, persona, background, folder, and preset images only, plus cold payloads and the DB.
  - `LoadLocalBackup`: stream parse, restore, `setDatabaseLite`, persist, reload.
  - The record framing is `globalApi.svelte.ts:LocalWriter.writeBackup`: `u32 nameLen`, `utf8 basename`, `u32 dataLen`, bytes. No header or version.
- `drive/drive.ts`:
  - `checkDriver(mode)`: Google OAuth. Browser modes are `save`/`load`. Node modes are `savetauri`/`loadtauri`, with a pasted code. Keep these `*tauri` names and the `accesstauri` state: they round-trip through the OAuth `state` parameter handled at `https://risuai.xyz/`.
  - `checkDriverInit`: the browser callback. Exchanges the code at `hubURL + '/drive/token'`.
  - Private `backupDrive`/`loadDrive` use `appDataFolder`:
    - Assets are uploaded as `<basename>.bin`. `formatKeys` handles the legacy `.png` naming.
    - The DB is `<unixSeconds>-database.risudat`.
  - `syncDrive` is a dormant sync mode.
- `drive/accounter.ts`: `risuLogin`, `saveRisuAccountData`/`loadRisuAccountData` (`/hub/account/*`), `loadRisuAccountBackup` (`/hub/backup/list|get`).
- `kei/kei.ts` `keiServerURL`: `db.keiServerURL`, or `hubURL + '/kei'`.
- `kei/backup.ts`:
  - `autoServerBackup`: bootstrap recovery only, via `/autobackup/list|restore`.
  - `saveDbKei`: called from `saveDb`, throttled to once per 5 minutes, POSTs the full DB to `/autobackup/save`.
- `sync/multiuser.ts`:
  - `createMultiuserRoom`: host, PeerJS ID ends with `-rmh`.
  - `joinMultiuserRoom`: joiner, uses the temp character `§temp`.
  - `peerSync`, `peerSafeCheck`, `peerRevertChat`.
  - Stores: `ConnectionOpenStore`, `ConnectionIsHost`, `RoomIdStore`.
  - Message union `ReciveData`: `request-char`, `receive-char`, `request-chat-sync`, `receive-chat`, `request-chat-safe`, ...
- `realm.ts`: `shareRealmCardData` (V3 PNG via `VirtualWriter`). `openRealm` is dead.
- `UI/Realm/RealmMain.svelte`: browse via `characterCards.ts:getRisuHub`.
- `RealmPopUp.svelte`: detail, report, and `downloadRisuHub`.
- `RealmFrame.svelte`: upload iframe to `https://realm.risuai.net/upload` with a postMessage handshake (`ping`/`pong`, then `[data, name]`).
- `RealmHubIcon.svelte`, `RealmLicense.svelte` (`CCLicenseData`).
- `RealmUpload.svelte`: unimported legacy.
- `SettingsExportButtons.svelte`: a redacted settings report (strips account, characters, and keys), request logs, and statistics.
- `public/functions/drive.js` `onRequest`: edge Google token exchange using `CLIENT_ID`/`CLIENT_SECRET`.

## Flows
- Entry points:
  - `UserSettings.svelte`: local backup buttons, account login and backup.
  - `FilesSettings.svelte`: Drive.
  - `bootstrap.ts`: `checkDriverInit`, `loadRisuAccountData`, and `autoServerBackup` (only when local recovery fails).
  - `globalApi.saveDb`: `saveDbKei`.
- Multiuser:
  1. The host answers `request-char` with a clone of the selected character that contains only the current chat, plus its assets.
  2. The joiner sends `request-chat-sync` from `peerSync`.
  3. The host applies it via `setDatabase` and broadcasts `receive-chat`.
  4. `sendChat` calls `peerSafeCheck` before generating, uses `peerRevertChat` when another peer is generating, and calls `peerSync` after.
- Realm: `MainMenu`/`MobileBody` → `RealmMain` → `getRisuHub(search, page, nsfw, sort)`. Export sets `ShowRealmFrameStore`, which shows `RealmFrame`. Success writes `realmId`.

## State
- DB: `account`, `keiServerURL`, `skipSavingAssetsOnWebSync`, `localNetworkMode`, `localNetworkTimeoutSec`, character `realmId`.
- Module state: `localStorage.risu_lastsaved`, the unused `BackupDb`, and the multiuser `conn`/`peer`/`connections`/`requestChatSafeQueue`.
- Stores: `OpenRealmStore`, `ShowRealmFrameStore`, `RealmInitialOpenChar`.
- `ColdStorageBackupPayload` = `{key, backupName, value, encoded}`.

## Coupling
- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (writers, `forageStorage`, fetch), `risuSave.ts` (`encodeRisuSaveLegacy`, `decodeRisuSave`), `coldstorage.svelte.ts`, `characterCards.ts` (`hubURL` and hub APIs), `alert.ts`, `platform.ts`, `sionyw.ts`.
- `process/index.svelte.ts` owns the order of the multiuser calls.

## Invariants
- The local backup format has no header. `LocalWriter.writeBackup` and `LoadLocalBackup` must change together, and old archives should still load.
- Every backup flow must carry the cold-storage payloads and validate them with `isColdStorageBackupData`. Missing keys prompt for confirmation.
- Full local backups strip `account`. Account-origin backups encrypt only the DB bytes (`encryption.risudat`).
- Multiuser code must snapshot before mutating and then call `setDatabase`/`setCurrentChat` for reactivity.
- `getLocalNetworkRequestOptions` must stay paired with `isLocalNetworkUrl`. Browsers reject the local route.

## Recipes
- Add a backup asset category: the asset map or scan in `SaveLocalBackup`/`SavePartialLocalBackup`, and `LoadLocalBackup` if record naming changes. Verify web and Node `forageStorage` restores.
- Change the archive format: `LocalWriter.writeBackup` and `LoadLocalBackup` together. Add a round-trip test.
- Change Drive: `checkDriver`/`checkDriverInit`/`backupDrive`/`loadDrive` plus the token exchange endpoint. Verify both the browser callback and the Node paste-code flow.
- Add a multiuser message: extend `ReciveData`, and handle it in both the host and joiner `conn.on('data')` switches.
- Change Realm: `characterCards.ts` hub functions and the matching `Realm*` component together. Check `hubURL` on Node (`/hub-proxy`).

## Tests
- Adjacent: `src/ts/network/localNetwork.test.ts`, `src/ts/network/proxyJobWs.test.ts`, `src/ts/process/coldstorageData.test.ts`.
- Not tested: backup framing and encryption, Drive, Account, Kei, multiuser, Realm, settings redaction.

## Known Hazards
- `LoadLocalBackup` writes `assets/` plus the record name, which is untrusted. The writer strips names to their basename, but the importer does not sanitize path separators.
- Drive assets use basename-only `.bin` names, so duplicate basenames collide. `lastSaved` is in milliseconds while Drive file names use seconds.
- On the host, `peerSafeCheck` can wait forever when `connections.length === 0`.
- `RealmFrame` accepts messages without checking `event.origin` and posts with `'*'`. `MainMenu` renders `hubAdditionalHTML` via `{@html}`.
- `shareRisuHub2` has `testMode = true`, so its server POST is unreachable.
