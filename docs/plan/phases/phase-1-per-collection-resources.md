# Phase 1: Per-Collection Resources

Status: implemented on 2026-09-29 in two review rounds; see Implementation Record.

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
  held assets), plus a list route so the existing restore UI ("Load Internal Backup" in
  `src/lib/Setting/Pages/UserSettings.svelte`) can offer server snapshots. Restore is a server operation that
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

## Implementation Record

Implemented on 2026-09-29 from a plan reviewed by GPT-6-Astra (39 points) and evaluated by Claude
Fable, in two rounds, each challenged by Astra and reviewed by Fable (Fable fixed the edge cases the
challenges found and wrote the tests). Slices:
[`slices/phase-1-per-collection-resources/`](slices/phase-1-per-collection-resources/).

- **Resources.** `shared/resources.ts` names the kinds and payloads. Singletons with id `main`:
  `root` (every `Database` field outside `ROOT_EXCLUDED_KEYS` = `characters`, `botPresets`,
  `modules`, `plugins`, `pluginCustomStorage`, the `set` list of the old encoder, closing the Phase 0
  observation), `presets`, `modules`, `plugins`, `pluginStorage`, `pluginPermissions`; per record:
  `characters` (id = `chaId`, all chats inside) and `inlays`. Normalizers check minimum shapes and
  return the input unchanged; defaults stay on the client.
- **Protocol.** Resource ids are relaxed to any well-formed string of 1-512 UTF-16 units without
  control characters, except `.` and `..` (the Playground character is `§playground`, and Lua uses
  asset paths as inlay ids); this changes the Phase 0 id rule. Every mutation carries the epoch
  (`x-resource-epoch`, 412 otherwise). New routes: the multi-kind read, the ref read, and the atomic
  batch (all conflicts listed, nothing applied).
- **Server backups.** Periodic snapshots (10 minutes when writes happened, 20 kept) under
  `save/backups/`, the list and restore routes (safety snapshot, validation, new epoch), and archive
  export/import (manifest v2 first; the whole archive is validated before any write; assets are only
  added, never overwritten). Maintenance closes resource and storage mutations with 503.
- **Client.** `loadData` assembles the `Database` from one read of every kind; the save adapter
  (`resourceSync.svelte.ts`) replaces the encoder, the `dbbackup` writes, `requiresFullEncoderReload`,
  and the `BroadcastChannel` guard. Deleted: `risuSave.ts` and remote saving
  (`enableRemoteSaving`). The storage namespaces are `assets` only.
- **Browser-local data.** Inlays, `SafeLocalPluginStorage`, the v3 permission grants, the Iris
  dialogue, and the Google search credentials are on the server; a boot step imports old browser
  copies (verify, then delete locally).

Recorded behavior changes:

- Characters load in creation order (identical to the old block order, since nothing reorders
  `db.characters`); `characterOrder` is unchanged.
- A stale write reloads that record in place and shows `resourceReloaded`; the old tab lock
  (`activeTabChange`, "click OK to activate this tab") is gone. Two tabs editing different
  characters no longer interfere.
- A failed save is retried with backoff (the old loop dropped it until the next change).
- Full backups carry every asset, not only `.png` files; archives made before this phase are not
  restorable (no migration owed).
- `getLocalPluginStorage()` is saved on the server and accepts plain JSON only (`TypeError`
  otherwise); `safeLocalStorage` stays device-local, as documented for plugin authors.
- Plugin permission answers are cached per plugin and permission (a grant for one permission no
  longer answers the others) and the grant hash uses the script the plugin was loaded with.
- Plugins load after `checkNewFormat` and `assignIds` (they loaded first before).
- Inlay blobs are never deleted (snapshots may reference them); `listInlayAssets` returns metadata.
- On a fresh server, setting the password also registers the browser's key, so the first run no
  longer fails with "Unknown public key" before a reload.
- On an import clash the server copy wins.

- A failing inlay image now rejects `writeInlayImage` instead of waiting forever.
- The Docker image runs `node server/src/main.ts` directly, so `docker stop` reaches the graceful
  shutdown (with `pnpm runserver` as PID 1 it exited without it).

Review, round 1 (server, slices 1-2): GPT-6-Astra challenged twice. Six bugs from the first challenge
were fixed by Opus (storage-route maintenance, shutdown tracking, export ordering, export staging
leak, a stuck import flag, silently skipped assets). The rest (nine edge cases: lookalike snapshot
databases, stale imports writing assets, unresolvable inlay asset keys, archive index amplification,
lazy admission, the export finalizer, draining storage writes, the shutdown response, duplicate
manifest names) were fixed by Claude Fable with tests; verdict no problem.

Review, round 2 (client, slices 3-5): Astra challenged three times. Five bugs were fixed by Opus
(a membership change during an in-flight save, the `flushResources` barrier, same-id inlay write
ordering, backup-download cancellation, a queued image write missing its load event); the last
challenge found nothing. Eight edge cases were fixed by Fable with tests (deferred conflict recovery
inside the state machine, root hydration echo from key order, batch sizing by UTF-8 bytes, epoch
invalidation outside the adapter, inlay cache freshness, the browser-local import keeping sources it
cannot verify and rereading before delete, the `__proto__` key in plugin storage); verdict no
problem.

Validation on 2026-09-29, final tree: `pnpm check` 0 errors (5,056 files, server `tsc` included);
`pnpm test` 50 files, 482 passed, 3 skipped; `pnpm build` passes; `pnpm format:check` passes. Manual
checks with the client in headless Chrome (DevTools protocol) against a fresh server, run by Opus and
re-run by Fable: first run sets the password once and creates the resources; a root field, a preset
field, a module, two characters, and a non-selected character's chat survive a reload, a deleted
character stays deleted, and an idle reload writes nothing; two tabs editing different characters do
not conflict, and a stale root write reloads that record with the notice; legacy entries in all five
browser stores move to the server and leave the browser (a non-JSON plugin value stays); inlays
render after clearing all site data and logging in again; export, change, import restores the
exported state and keeps existing assets, a later write in that tab is refused with the restore
notice; restoring a snapshot restores its state. Docker (`risu-metatron:phase1` with `save/` on a
mounted volume): first run in the browser, data kept across `docker restart` (graceful, "SIGTERM
received" logged), export, import, and snapshot restore through the API.
