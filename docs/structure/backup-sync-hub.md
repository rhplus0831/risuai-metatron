# Backups, Cloud Sync, Multiuser, Realm Hub

## Scope
- Owns:
  - local `.bin` backup export and import (full and partial),
  - PeerJS multiuser chat sync,
  - Realm hub browse and download (upload, report, and remove were removed),
  - the settings report export.
- Paths:
  - `src/ts/drive/backuplocal.ts` (the folder name is historical; Google Drive sync, Risu Account sync, and Kei auto-backup were removed)
  - `src/ts/sync/multiuser.ts`
  - `src/lib/UI/Realm/*`
  - `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`
- Not here:
  - The save format and backends → `persistence.md`.
  - Hub URL and card codecs → `characters-modules.md` (`characterCards.ts`).
  - Node `/hub-proxy` → `self-host-server.md`.
  - `localNetwork.ts`/`proxyJobWs.ts` → `global-api.md`.

## Files
- `drive/backuplocal.ts`:
  - `SaveLocalBackup`: all `.png` assets and `database.risudat` (legacy compressed DB).
  - `SavePartialLocalBackup`: profile, persona, background, folder, and preset images only, plus the DB.
  - `LoadLocalBackup`: stream parse, restore, `setDatabaseLite`, persist, reload. Before writing anything, `isAccountEncryptedBackup` scans only the record headers (random-access `File.slice`) for `encryption.risudat`, which marks a Risu Account-encrypted archive. Such archives are rejected with an error because the key server is no longer used.
  - The record framing is `globalApi.svelte.ts:LocalWriter.writeBackup`: `u32 nameLen`, `utf8 basename`, `u32 dataLen`, bytes. No header or version.
- `sync/multiuser.ts`:
  - `createMultiuserRoom`: host, PeerJS ID ends with `-rmh`.
  - `joinMultiuserRoom`: joiner, uses the temp character `§temp`.
  - `peerSync`, `peerSafeCheck`, `peerRevertChat`.
  - Stores: `ConnectionOpenStore`, `ConnectionIsHost`, `RoomIdStore`.
  - Message union `ReciveData`: `request-char`, `receive-char`, `request-chat-sync`, `receive-chat`, `request-chat-safe`, ...
- `UI/Realm/RealmMain.svelte`: browse via `characterCards.ts:getRisuHub`.
- `RealmPopUp.svelte`: detail, copy link, and `downloadRisuHub`.
- `RealmHubIcon.svelte`, `RealmLicense.svelte` (`CCLicenseData`).
- `SettingsExportButtons.svelte`: a redacted settings report (strips characters and keys), request logs, and statistics.

## Flows
- Entry points:
  - `UserSettings.svelte`: local backup buttons, internal backup restore, dataset export.
- Multiuser:
  1. The host answers `request-char` with a clone of the selected character that contains only the current chat, plus its assets.
  2. The joiner sends `request-chat-sync` from `peerSync`.
  3. The host applies it via `setDatabase` and broadcasts `receive-chat`.
  4. `sendChat` calls `peerSafeCheck` before generating, uses `peerRevertChat` when another peer is generating, and calls `peerSync` after.
- Realm: `MainMenu`/`MobileBody` → `RealmMain` → `getRisuHub(search, page, nsfw, sort)` → `RealmPopUp` → `downloadRisuHub`. There is no upload path.

## State
- DB: `localNetworkMode`, `localNetworkTimeoutSec`. `setDatabase` deletes the legacy `account` token; old saves may still carry an unused character `realmId`.
- Module state: the multiuser `conn`/`peer`/`connections`/`requestChatSafeQueue`.
- Stores: `OpenRealmStore`, `RealmInitialOpenChar`.

## Coupling
- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (writers, `forageStorage`, fetch), `risuSave.ts` (`encodeRisuSaveLegacy`, `decodeRisuSave`), `characterCards.ts` (`hubURL` and hub APIs), `alert.ts`, `platform.ts`.
- `process/index.svelte.ts` owns the order of the multiuser calls.

## Invariants
- The local backup format has no header. `LocalWriter.writeBackup` and `LoadLocalBackup` must change together, and old archives should still load.
- Backups no longer carry cold-storage records. `LoadLocalBackup` skips legacy `coldstorage_<uuid>.json` records from older archives and writes every other non-database record to `assets/`.
- Unencrypted local archives must keep loading. Risu Account-encrypted archives (`encryption.risudat`) are rejected, not decrypted.
- Multiuser code must snapshot before mutating and then call `setDatabase`/`setCurrentChat` for reactivity.
- `getLocalNetworkRequestOptions` must stay paired with `isLocalNetworkUrl`. Browsers reject the local route.

## Recipes
- Add a backup asset category: the asset map or scan in `SaveLocalBackup`/`SavePartialLocalBackup`, and `LoadLocalBackup` if record naming changes. Verify web and Node `forageStorage` restores.
- Change the archive format: `LocalWriter.writeBackup` and `LoadLocalBackup` together. Add a round-trip test.
- Add a multiuser message: extend `ReciveData`, and handle it in both the host and joiner `conn.on('data')` switches.
- Change Realm: `characterCards.ts` hub functions and the matching `Realm*` component together. Check `hubURL` on Node (`/hub-proxy`).

## Tests
- `src/ts/drive/backuplocal.test.ts`: `LoadLocalBackup` record parsing, rejection of account-encrypted archives, and the skip of legacy `coldstorage_<uuid>.json` records.
- Adjacent: `src/ts/network/localNetwork.test.ts`, `src/ts/network/proxyJobWs.test.ts`.
- Not tested: the backup writers, multiuser, Realm, settings redaction.

## Known Hazards
- `LoadLocalBackup` writes `assets/` plus the record name, which is untrusted. The writer strips names to their basename, but the importer does not sanitize path separators.
- On the host, `peerSafeCheck` can wait forever when `connections.length === 0`.
- `MainMenu` and `RealmMain` render `hubAdditionalHTML` via `{@html}`.
