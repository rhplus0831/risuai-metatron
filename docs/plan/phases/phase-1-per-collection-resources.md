# Phase 1: Per-Collection Resources

Status: not started.

Depends on: Phase 0.

## Objective

Replace the single `database/database.bin` blob with per-collection server resources at the
granularity the encoder already uses, delete the block codec, client-side backups, remote saving,
and the multi-tab channel, and bring browser-local user data to the server. The client still reads
and mutates `DBState.db` exactly as before; only load and save change.

## Required Work

- **Resources.** `root` (every field the encoder keeps in its root block), `presets`
  (`botPresets`), `modules`, `plugins`, `pluginStorage` (`pluginCustomStorage`), and
  `characters/<chaId>` with its chats still inside. This mirrors `toSaveType` and the exclusion list
  in `RisuSaveEncoder.init` and `set`.
- **Load.** `loadData` in `src/ts/bootstrap.ts` fetches the resources instead of calling
  `decodeRisuSave`, assembles the in-memory `Database`, and still runs `setDatabase`,
  `checkNewFormat`, and `assignIds` on the client. Those move to the server in Phases 2 and 3.
- **Save.** `saveDb` keeps its `$effect` watchers and `changeTracker`, but the loop writes only the
  changed resources with their revisions instead of `encoder.set` plus a full `encode`. Remove
  `requiresFullEncoderReload` and its two writers: `removeChar` in `src/ts/characters.ts` and the
  restore path in `src/ts/drive/backuplocal.ts` write through the same resource writes. On a 409 the
  client reloads that resource into the mirror and shows the alert that the tab channel used
  (`language.activeTabChange`).
- **Delete.** `src/ts/storage/risuSave.ts` (encoder, decoder, legacy codecs, and the `risuSaveCache`
  LocalForage instance), `getDbBackups` and the `dbbackup-*` writes in `globalApi.svelte.ts`,
  `enableRemoteSaving` and the `remotes/` handling, and the `BroadcastChannel("risu-db")` guard.
- **Server backups.** A periodic `sqlite.backup()` snapshot of the resource database under
  `save/backups/` with a retention count (assets are not part of it, as the `dbbackup-*` files never
  held assets), plus a list route so the existing restore UI in
  `src/lib/Setting/Pages/Advanced/` can offer server snapshots. Restore is a server operation that
  drains mutations, imports atomically, and advances the database epoch (Decision 1).
- **Local backup archives.** `src/ts/drive/backuplocal.ts` imports `encodeRisuSaveLegacy` and
  `decodeRisuSave` from the codec this phase deletes, so its archive export and restore move to a
  server export and import route (resources plus assets) in this phase. Archives made before this
  phase are not restorable, which the no-migration rule allows; shared artifact formats are
  unaffected.
- **Browser-local user data.** Inlays (`src/ts/process/files/inlays.ts`, LocalForage `inlay`) become
  server resources under an `inlays` kind with the blob in the `assets` namespace and metadata in the
  resource. Plugin safe storage (`SafeLocalPluginStorage` in `src/ts/plugins/pluginSafeClass.ts`)
  moves into the `pluginStorage` resource. The v3 permission grants (`plugin_permissions` in
  `src/ts/plugins/apiV3/v3.svelte.ts`) become a separate server-owned `pluginPermissions` resource
  that no plugin snapshot or plugin write path (including `setPluginDatabase` and
  `pluginCustomStorage` replacement) can read or write, so a plugin cannot grant itself a
  permission. The Iris dialogue (`src/lib/Others/IrisModal.svelte`) and the
  Google search credentials (`src/ts/process/mcp/googlesearchclient.ts`) move into `root`.
  Rebuildable caches stay browser-local and are listed as such in `persistence.md`: `hypaVector`,
  `LLMTranslateCache`, `tfCache`, `firefox-translations-models`, `mcp-tool-calls`, and the
  `strongBan_*` and `nightlyWarned` `localStorage` keys.
- **Server namespaces.** `STORAGE_NAMESPACES` in `server/src/routes/storage.ts` keeps `assets`.
  Remove `database` and `remotes` once nothing reads them; `NodeStorage` keeps only the asset
  methods it still needs.
- **Docs.** Rewrite the `Flows`, `Block format`, and `Backend` sections of
  `docs/structure/persistence.md`; update the routes table and `State` in
  `docs/structure/self-host-server.md`; update D1, D2, and D4 in `STRUCTURE.md` and the `saveDb`
  description in `docs/structure/global-api.md`.

## Safety Contract

The client's read and write surface is unchanged: every `DBState.db` reference, binding, and
assignment keeps working, and the `saveDb` watchers act as the write adapter of invariant 2 for
every collection in this phase. Until Phase 2 a character resource carries all of its chats under
one revision, so two tabs editing different chats of one character conflict and one reloads; this
is expected, not a defect. Card, preset, module, and translator-preset import and export are
untouched. No LocalForage user data is deleted until its server copy is read back successfully.

## Exit Criteria

- A fresh server starts, the first client run creates the resources, and a save followed by a
  reload preserves every collection.
- With two tabs open, a stale write is rejected and that tab's mirror reloads.
- No `database.bin`, no client-side backup writes, no `remotes/` payloads, and no `BroadcastChannel`
  remain.
- Inlays referenced by chat text render after clearing browser storage.
- A local backup archive made in this phase restores through the server route.
- A plugin cannot read or change permission grants through any v3 API.
- The touched guides and invariants describe the new layout.

## Validation

Server resource and backup route tests, a manual save, reload, and two-tab check recorded in the
phase file, and `pnpm check`, `pnpm test`, `pnpm format:check`.
