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
  - `localNetwork.ts`/`proxyJobWs.ts` → `global-api.md`.

## Files

- `drive/backuplocal.ts` (the server builds and reads the archive; see `self-host-server.md`):
  - `SaveLocalBackup`: `flushResources`, then `POST /api/backups/export` (every asset on the server, inlays included, plus a snapshot of the resources), streamed to a file through `LocalWriter.write`. The manifest (first record) is read from the stream head; assets the database references but the archive lacks are reported.
  - `SavePartialLocalBackup`: the same with `partial`: character/group profile images, user icon, persona icons, background, folder images, preset images (no inlays, emotion images, additional assets, VITS, or CC assets); the manifest's `missing` list is reported.
  - `LoadLocalBackup`: posts the chosen `File` to `POST /api/backups/import` and reloads. The server refuses Risu Account archives (`encryption.risudat`) and archives from before Phase 1 (`database.risudat`, no migration owed).
- `globalApi.svelte.ts` `loadInternalBackup` ("Load Internal Backup" in `UserSettings.svelte`): lists the server snapshots (taken every 10 minutes while data changes, 20 kept), restores the chosen one, reloads.
- `UI/Realm/RealmMain.svelte`: browse via `characterCards.ts:getRisuHub`.
- `RealmPopUp.svelte`: detail, copy link, and `downloadRisuHub`.
- `RealmHubIcon.svelte`, `RealmLicense.svelte` (`CCLicenseData`).
- `SettingsExportButtons.svelte`: a redacted settings report (strips characters, keys, `irisDialogue`, `googleSearchCredentials`, and `pluginCustomStorage`), request logs, and statistics.

## Flows

- Entry points:
  - `UserSettings.svelte`: local backup buttons, internal backup restore, dataset export.
- PeerJS multiuser chat (rooms, peer sync, and the `peerjs` dependency) was removed.
- Realm: `MainMenu` → `RealmMain` → `getRisuHub(search, page, nsfw, sort)` → `RealmPopUp` → `downloadRisuHub`. There is no upload path.

## State

- DB: `localNetworkMode`, `localNetworkTimeoutSec`. `setDatabase` deletes the legacy `account` token; old saves may still carry an unused character `realmId`.
- Stores: `OpenRealmStore`, `RealmInitialOpenChar`.

## Coupling

- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (`LocalWriter`, fetch), `storage/resourceClient.ts` (`exportBackup`, `importBackup`, `listBackups`, `restoreBackup`), `storage/resourceSync.svelte.ts` (`flushResources`), `characterCards.ts` (`hubURL` and hub APIs), `alert.ts`, `platform.ts`.

## Invariants

- The archive format (version 2, `manifest.json` first) is defined by the server; the client only streams it and reads the manifest. Archives made before Phase 1 are not restorable, and neither is an archive or snapshot whose resource database has another schema version than the server's (3 since Phase 3): the server refuses it with a message, and no migration is owed.
- Export, change, and restore are covered end to end on a version-3 store (Phase 4 closeout): an archive import undoes changes made after the export (a plugin `setCharacter`, an MCP tool), and restoring the safety snapshot the import took brings them back.
- A backup restore replaces every resource and only adds assets that do not exist yet; the app reloads afterwards because every revision the tab held is void (new epoch).
- Private backups carry everything, including `googleSearchCredentials`, the Iris dialogue, plugin storage, and the plugin permission grants.
- `getLocalNetworkRequestOptions` must stay paired with `isLocalNetworkUrl`. Browsers reject the local route.

## Recipes

- Add a partial-backup asset category: `partialAssets` in `backuplocal.ts` (a full backup already takes every asset).
- Change the archive format: the server side (see `self-host-server.md`) and `tryReadManifest` here. Add a round-trip test.
- Change Realm: `characterCards.ts` hub functions and the matching `Realm*` component together. Check `hubURL` on Node (`/hub-proxy`).

## Tests

- `src/ts/drive/backuplocal.test.ts`: over a fake `authFetch` and a fake `LocalWriter`: the flush before an export, the archive streamed to the file with the manifest read across chunk boundaries, the missing-asset report by character and role, no export when the flush fails, response cancelled when the writer cannot open, stream cancelled and writer aborted on a write failure, writer aborted on a broken download, a refused export reported; the partial backup's two confirmations and key list; `LoadLocalBackup` posting the file with the epoch header and reloading, the server's refusal shown, and a 412 reloading without an error.
- Adjacent: `src/ts/network/localNetwork.test.ts`, `src/ts/network/proxyJobWs.test.ts`.
- Not tested: `LocalWriter` itself (streamSaver), Realm, settings redaction.

## Known Hazards

- `MainMenu` and `RealmMain` render `hubAdditionalHTML` via `{@html}`.
