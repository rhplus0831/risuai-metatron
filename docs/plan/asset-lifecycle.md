# Asset Lifecycle Plan

Status: drafted 2026-11-03, no slice landed. Decisions D1–D12 are recommendations for the owner; the
**Open questions** Q1–Q3 wait for the owner. Code anchors were checked at `8f0db0fb7`; verify them again
before editing (STRUCTURE.md protocol step 5).

Sources: the owner's 2026-11-03 review of the research backlog, which picked this plan because five notes
converge on it: [PocketRisu and RisuBard picks](../research/pocketrisu-risubard-picks.md) §1.2 item 6 (the
storage dashboard and orphan cleanup) and §2.2 Storage and Deletion Policies (the policies the owner already
adopted: fail-closed deletion, a grace period, automatic deletion opt-in only, a recheck right before each
delete, usage as logical size plus deduplication savings, per-character and per-module shares, a disk-space
preflight before heavy operations); [RisuNest ideas](../research/risunest-ideas.md) §1 item 7 (asset garbage
collection: how far the mark phase must scan free text, the grace period, pinned-snapshot semantics) and item 8
(snapshot controls: manual, labeled, pinned, sizes, delete), whose open item 4 in the
[research README](../research/README.md) this plan answers in D2 and D8;
[HaejeokRisuai survey](../research/haejeok-feature-survey.md) candidate C2 (an orphan report with a dry run,
every kept snapshot a reference, deletion under the maintenance lock);
[server/client stabilization audit](../research/deep-audit/server-client-stabilization.md) F08 (no coordinated
retention: mark from live records, retained snapshots, checkpoints, and prepared operations, then a grace
period), F13 (the fallback path reads originals, not thumbnails), and "Prepared exports hold live asset paths"
(a staged upstream export names files that a deletion between prepare and download breaks); the
[found-issues](../research/found-issues.md) entry "checkpoints.sweep has no product caller". Guides at
`8f0db0fb7`: [server resources](../structure/server-resources.md) (Snapshots and restore, Maintenance, the
Issues entry that retained snapshots keep asset references forever), [self-host server](../structure/self-host-server.md)
(Storage routes, Disk layout, User files, Thumbnail cache, Known Hazards), [persistence](../structure/persistence.md)
(asset lists are immutable tuples; keys are on-disk names), and [global API](../structure/global-api.md) (Asset
sources, Asset client).

Owning guides when sliced: [self-host server](../structure/self-host-server.md) (the report, scan, and sweep
routes, the lifecycle database, the lease, the per-key publish lock, the disk preflight), [server resources](../structure/server-resources.md)
(snapshot pins and labels, manual snapshots, deletion, the per-snapshot reference index, the roots a restore or
an import adds), [global API](../structure/global-api.md) (the client calls), [settings and i18n](../structure/settings-i18n.md)
(the Storage section of Advanced settings), [test harness](../structure/test-harness.md) (the browser check).

Relation to completed plans (see [the archive](../archived-plan/README.md)): Direct Asset URLs made
content-named assets immutable in the browser cache, which D11 accounts for; Server Thumbnails added the
derived cache that D3 treats as a non-root removed with its key; Large Asset Import and Export added the batch
write that publishes by rename, which D7 relies on; Server Byte Budgets bounded request and restore memory but
left disk use unreported (F08). None of them is re-proposed.

## Goal

The server can tell which stored assets are still referenced, report where the disk goes, and remove
unreferenced assets safely:

- One retention graph: live records, every retained snapshot, chat checkpoints, prepared exports, and recent
  uploads are roots; an asset no root names is unreferenced. Snapshot count, checkpoint pruning, and export
  staging stop being independent counters that each hold assets without knowing it.
- A report the user can read: logical size (every reference counted), deduplicated size (what is on disk),
  the savings between them, shares per character, module, persona, and settings, unreferenced bytes, bytes
  past the grace period, and the disk's free space, beside the snapshot list with sizes and the bytes each
  snapshot alone holds.
- Deletion that fails closed: nothing is deleted while any root cannot be read in full, nothing younger than
  the grace period is deleted, the dry run is the report itself, each delete is rechecked right before it, and
  the user starts it.
- Snapshots a user can pin, label, take, and delete, so "keep the state before I try this module" is cheap and
  a pinned snapshot keeps its assets for as long as it exists.

Not goals: a byte budget that deletes referenced data or rotates pinned snapshots, deleting thumbnails
separately from their source, snapshot content browsing or per-record restore (HaejeokRisuai C3), compaction
of `resources.sqlite`, multi-user servers.

## Current state

The baseline is `8f0db0fb7` on `dev` (2026-11-03). This plan does not re-propose it.

- **Assets are content-named files that nothing deletes.** A logical key `assets/<sha256>.<ext>` (or
  `assets/inlay_<sha256>.<ext>`, or a custom id) lives at `save/assets/<encodeFileName(name)>`
  (`server/src/routes/storage.ts`, `resolveStorageKey`). Writes stage under `save/.tmp/` and publish by rename
  (`writeStorageFile`; the batch route `POST /api/assets/write` the same, record by record). The only delete is
  `GET /api/remove`, which no client calls. `src/ts/process/files/inlays.ts` states the policy at its header:
  committed blobs are never deleted because retained snapshots may reference them, and `removeInlayAsset`
  deletes only the metadata record.
- **Snapshots are retained by count.** `server/src/data/snapshots.ts` keeps the newest 20 `resources-*.sqlite`
  files under `save/backups/` (`DEFAULT_KEEP`, `takeLocked`'s `list().slice(keep)` loop); a snapshot copies the
  resource database, never assets, so every retained snapshot holds asset references nothing counts. There is
  no pin, label, manual snapshot, or delete; `BackupSnapshotInfo` is `{ id, createdAt, size }`
  (`shared/resources.ts`), and the tab's `loadInternalBackup` (`src/ts/globalApi.svelte.ts`) lists dates and
  restores. The manager's `pin(id, target)` is a different thing: the hard link a restore takes so retention
  cannot remove its source mid-validation.
- **Reference collection exists for exports, not for retention.** `server/src/data/upstream/assetReferences.ts`
  walks the typed asset fields of characters (image, emotions, additional assets, VITS files, `ccAssets`,
  the GPT-SoVITS reference), the `ui` section's background, personas and their embedded modules, folder
  images, preset images, and modules (`assets`, `icon`); `shared/backups.ts` `selectPartialBackupAssets` and
  the tab's `referencedAssets` (`src/ts/drive/backuplocal.ts`) are narrower copies. None reads inlays, chat
  text, checkpoint pages, or snapshots.
- **Asset keys reach free text.** Chat messages carry `{{inlay::id}}`, whose id names an `inlays` record with
  the `asset` key (typed), but the server Lua `getCharacterImageMain` and `getPersonaImageMain`
  (`server/src/lua/bindings.ts`) answer `{{inlayed::assets/<key>}}` with the asset key itself when the image
  is a usable inlay, and `drawInlay` uses the key as the inlay id. `{{asset::name}}`, `{{img::}}`, and the
  other by-name CBS forms resolve through the character's or module's typed list (`src/ts/parser/parser.svelte.ts`),
  so they carry no key. Checkpoint pages hold message `data` verbatim (`server/src/data/checkpointStore.ts`
  header), so whatever a message held, a checkpoint holds.
- **Prepared exports hold file paths.** `server/src/routes/backupsUpstreamExport.ts` builds a staged export
  whose `assets` list names each referenced asset's file, then waits up to `UPSTREAM_EXPORT_STAGED_TTL_MS`
  (10 minutes, `shared/upstreamExportReport.ts`) for the download, which reads those files. The version-2
  export (`POST /api/backups/export`) streams in one request and holds nothing between requests. Realm and
  upstream imports stage under `.tmp/` and write their assets at commit.
- **Thumbnails are derived.** `server/src/http/assetThumbnails.ts` caches WebP variants under
  `save/cache/thumbnails/<sha256(key)>/`; `removeKey` drops a key's directory and `/api/remove` calls it; a
  sweep after listen drops entries whose source is gone or changed (`server/src/app.ts`, `startBackgroundTasks`).
  The cache has no byte cap (self-host server Issues). The tab's fallback path (`getThumbSrc` without a
  capable worker, `src/ts/globalApi.svelte.ts`) reads the original instead (F13), unchanged by this plan.
- **Checkpoint pages have an unused wrapper.** `store.checkpoints.sweep` (`server/src/data/resourceStore.ts`)
  is called by tests only; the table-wide page sweep runs at open. A deleted chat's pages wait for a restart.
- **The maintenance lock is heavy.** `withMaintenance` runs the `onMaintenance` listeners first, which abort
  every generation job, then closes resource and storage mutations (503) until the body ends. `exclusive`
  only serializes with other whole-database operations (snapshots, export copies, restores, imports) and
  closes nothing. The storage routes' `enterMaintenanceGate` admits a file write that maintenance then waits
  for.
- **No disk preflight anywhere.** No server module calls `statfs`; a restore, an import, or the snapshot tick
  on a full disk fails mid-way.
- **Server-read settings.** A setting the server reads lives in the `providers` section and is read through
  `readProviders()` in `server/src/app.ts` (`requestHistoryLimit` is the pattern); device-local preferences
  live in `localStorage`.

## Decisions

- **D1. References are discovered by scanning, not by an index maintained on write.** A mark run reads the
  live store in one read transaction (every `resources` row, every `messages` row, every `checkpointPages`
  row, and the structured memory page tables, each prefiltered in SQL with `instr(text, 'assets/') > 0` and
  parsed only when the prefilter hits), and reads each retained snapshot the same way. A snapshot is
  immutable, so its reference set is computed once, at the first run that sees it, and stored by snapshot id;
  the live store is scanned on every run. Rejected: a reference index updated by every write path (chat
  writes, resource patches, checkpoint captures, Lua inlays, imports, restores). A writer the index misses
  deletes data silently, which is the opposite of fail-closed, and the index would have to be rebuilt after
  every restore anyway. The scan's cost on a large store is measured in Slice 1 and recorded in
  `docs/audit/asset-scan-<date>.md`; the prefilter keeps it to the rows that can hold a key.
- **D2. What counts as a reference in text (RisuNest open item 4).** The mark is string-level and
  over-approximating: inside every string value of a parsed row (any depth), every substring matching
  `assets/<name>` where `<name>` is a character run the file-name codec accepts, and every `/api/asset/<hex>`
  whose hex decodes to such a key, is a reference. This subsumes the typed walk (the same strings), catches
  `{{inlayed::assets/…}}`, HTML written by regex scripts or `backgroundHTML`, and lorebook or module text that
  pasted a key, and keeps a key that merely looks referenced (the safe direction). By-name CBS forms need no
  handling: they resolve through typed lists that are themselves scanned. The typed walk
  (`collectAssetReferences`, extended with inlays and owner ids) is still run, for attribution only (D9).
  Rejected: a typed walk alone (misses the Lua key form and any text a plugin or script wrote), and a
  CBS-aware parse of message text (slower, and a key outside CBS syntax would be missed).
- **D3. Roots.** An asset is referenced when any of these names it: the live store (D1's tables, all kinds,
  including `inlays` records and checkpoint pages); every listed snapshot in `save/backups/`, pinned or not,
  safety snapshots included; every prepared upstream export until its download, cancel, or TTL
  (`backupsUpstreamExport.ts` exposes `heldAssetKeys()`); the recent-use lease (D7); and youth: a file whose
  mtime is within the grace period. Non-roots: the thumbnail cache (derived; `thumbnails.removeKey` runs with
  the delete), Realm and upstream import staging (under `.tmp/`, not `assets/`; the commit's writes are young
  files), the browser's caches (D11), and generation jobs (an inlay a job writes is a young file and then an
  `inlays` record). Restore and import need no special root: a restored snapshot is already a listed root,
  and an imported archive's assets are young.
- **D4. The grace period and the unreferenced ledger.** A new database `save/data/asset-lifecycle.sqlite`
  (beside `generation-jobs.sqlite`, outside snapshots, so a restore never rolls the ledger back) holds
  `snapshotRefs(snapshotId, key)`, `unreferenced(key, since, bytes)`, and `runs(startedAt, complete, reasons,
counts)`. A run inserts a key found unreferenced with `since = now` if absent, deletes a key found referenced,
  and leaves the rest. A key is deletable when `since + grace <= now`, the file's mtime is older than `grace`,
  and the recheck (D6) agrees. `grace` defaults to 7 days (`RISU_ASSET_GRACE_DAYS`, Q1). A read-only scan runs
  daily (one hour after `startBackgroundTasks`, then every 24 hours, skipped while a restore or import holds
  the lock), so the clocks tick without anyone opening the page; the user can start one from the report.
  Rejected: a tombstone per deleted key (nothing consults it after the file is gone; D11 explains the browser
  side), and keeping the ledger in `resources.sqlite` (a restore would resurrect old `since` stamps).
- **D5. Fail-closed.** A run's result is `complete: false` with reasons when any root could not be read in
  full: a listed snapshot that cannot be opened or walked, a store table read that throws, the export staging
  not answering, the assets directory not listable. An incomplete run still updates the report's sizes and
  shares but writes nothing to `unreferenced` and makes `POST /api/assets/sweep` a 409
  `Reference set incomplete`. A file whose name the codec cannot round-trip (`decodeFileName` returns null)
  is listed as "unmanaged bytes" and is never a candidate. A key whose owner the typed walk does not know is
  still a reference (D2); unknown owners only affect attribution.
- **D6. Sweep mechanics.** The report is the dry run: it lists the candidates (deletable keys, bytes, how long
  unreferenced). `POST /api/assets/sweep` `{ dryRun: boolean, keys?: string[] }` (`dryRun: true` answers what
  would be deleted without touching anything; `keys` narrows a run to a selection) requires the latest run to
  be complete and no older than one hour, else 409. Deletion goes in batches of 200 keys, each batch a turn of
  `snapshots.exclusive` so it never overlaps a restore's or an import's install: if `store.writeCount()`
  moved since the mark, the live store is re-marked first (snapshot sets are already indexed; the export
  staging is re-asked); then per key, under that key's publish lock (D7): still in the candidate set, not
  leased, mtime still older than `grace`, then `unlink`, `assetVerification.forgetVerification`,
  `thumbnails.removeKey`, and the ledger row removed. The answer is `{ deleted, freedBytes, skipped: [{ key,
reason }] }`; a filesystem error skips the key with its reason and continues (unlike `/api/remove`).
  Rejected: `withMaintenance` for the sweep (it aborts every generation job and answers 503 to every write
  for the sweep's length; the exclusive batches plus the per-key lock give the needed ordering without that).
- **D7. Concurrency with uploads and reads.** Three rules close the window between "unreferenced" and a new
  reference. Youth: the mtime rule of D3 covers every write that publishes a file (batch and single writes,
  import commits, Lua inlays). The lease: an in-memory, bounded map of key → last use, bumped when
  `POST /api/assets/missing` answers that a key is present (the client then skips the upload and writes a
  record naming it) and when `/api/asset/*` serves it; a key used within `ASSET_LEASE_MS` (one hour) is a
  root. The per-key publish lock: `writeStorageFile`'s rename and the batch route's per-record rename take a
  key-level lock (a small `assetLocks` map in `routes/storage.ts`, shared with the sweep), and the sweep holds
  the same lock from its recheck to its `unlink`, so a publish and a delete of one key never interleave. The
  lease is lost at restart, which is acceptable: the first scheduled scan is an hour after start, a manual
  sweep needs a complete run no older than an hour, and the mtime rule stands regardless. Rejected: making
  `/api/assets/write` refuse during a sweep (it is a 503 the client retries, but a client that got "present"
  from the missing check does not write at all).
- **D8. Pinned and labeled snapshots.** `snapshots.ts` gains `setPinned(id, pinned, label?)` and `remove(id)`;
  retention counts unpinned snapshots only (`keep` of them), a pinned snapshot is never rotated, and
  `remove` refuses a pinned id (409) until it is unpinned. Pins and labels live in `save/backups/pins.json`
  (durable write; an entry whose file is gone is dropped at list time), not in the snapshot file, and are not
  carried by a restore. `BackupSnapshotInfo` gains `pinned`, `label`, and `heldBytes` (D9). `snapshotNow`
  takes `{ label? }` for the manual snapshot. At most 20 pinned snapshots (409 beyond; Q3). The existing
  `pin(id, target)` (the restore's hard link) is renamed `stageCopy` to free the word (V4). A pinned
  snapshot is a root like any other (D3): pinning extends an asset's life for as long as the pin exists,
  which is RisuNest item 8's semantics and the answer to open item 4's "pinned-snapshot" half. Rejected: a
  daily tier (keep one per day for D days); pins cover the need the owner named and a tier is in **Later**.
- **D9. The report and where it shows.** `GET /api/assets/report` answers the latest run (no-store):
  `generatedAt`, `complete` and `reasons`, `running`, `disk: { free, total }`, `usage: { assetsOnDisk,
resourcesDb, snapshots, thumbnails, staging, unmanaged }`, `referenced: { logicalBytes, dedupedBytes,
savings, count }`, `unreferenced: { count, bytes, pastGrace: { count, bytes }, candidates: [{ key, bytes,
since }] }` (the candidate list capped at 2,000 entries with a total), `owners: [{ kind: "character" |
"module" | "persona" | "preset" | "folder" | "settings" | "inlays", id, name, bytes, count }]`, and
  `snapshots: [{ id, createdAt, size, pinned, label, heldBytes }]`. Logical bytes sum each reference's file
  size (a profile image three characters share counts three times); deduplicated bytes sum unique files;
  the owner shares are logical and may sum past the deduplicated total, which the UI says. Inlays are
  attributed to the character whose chat holds the message (`messages.chatSeq → chats.characterId`), and to
  `inlays` when no chat does. `heldBytes` of a snapshot is the size of the keys only that snapshot
  references (no other root). `POST /api/assets/scan` starts a run (409 while one runs); the UI polls
  `report` while `running`. The UI is a new "Storage" section of Advanced settings
  (`advancedSettingsSections` in `src/ts/setting/advancedSettingsData.ts`, a `custom` item rendered by a new
  `src/lib/Setting/Pages/Advanced/StoragePanel.svelte` registered in `src/ts/setting/customComponents.ts`,
  the `DiagnosticsPanel` pattern): the totals, the owner table, the candidate list with a Delete button that
  confirms with the count and bytes, and the snapshot list with Take, Pin, Label, Restore, and Delete.
  `loadInternalBackup` on the User page stays as it is. Rejected: a settings page of its own (the registry's
  sectioned pages already give search and jumps; a new page needs a menu index and routes).
- **D10. Manual deletion in this plan; automatic deletion opt-in later (Q2).** The slices ship the scan
  (automatic, read-only) and the sweep (user-started). An automatic sweep, if the owner wants it, is one
  `providers` field `assetAutoSweep` (default off) that makes the daily scan's complete run end with a sweep
  under D6's rules; it is **Later** unless Q2 says now, in which case it joins Slice 2. Rejected: automatic
  deletion on by default (the adopted policy says opt-in).
- **D11. Deleted hashes and the browser's immutable cache.** A sweep deletes only keys no root named for at
  least the grace period, so no live record renders them; a tab that still shows one holds a page it has not
  reloaded for that long, and the browser cache keeps showing the cached bytes until eviction, then the
  element gets a 404, as a missing file does today (global API, Asset sources). The service worker's
  fallback cache (`risuCache`) is unaffected. Re-uploading the same bytes recreates the same key, so a cached
  URL never shows wrong content. No server-side tombstone or 410 list (D4). The guide records this under
  Limitations with a decision pointer.
- **D12. Disk preflight.** A helper `freeBytes(path)` over `fs.statfs` (Node 24) backs the report's `disk`
  and a preflight in the heavy operations: `POST /api/backups/:id/restore` (twice the snapshot's size: the
  safety snapshot and the install), `POST /api/backups/import` and the upstream commit (the archive's
  database plus its assets not yet on disk), the upstream export prepare (the database copy plus the encoded
  save), and the snapshot tick (the database's size; a short tick logs once and skips, it never throws).
  The threshold is the estimate plus 5 percent and a floor of 64 MiB; a short answer is 507
  `Insufficient Storage` with `{ needed, free }` before any staging is written. A `statfs` failure
  (unsupported filesystem) disables the preflight for that operation with one log line: it is a guard for a
  user-started operation, not a deletion, so it fails open. Rejected: a byte budget that deletes to make
  room (F08's budget idea; not a goal).

## Open questions

- **Q1. The grace period.** Recommended: 7 days, PocketRisu's value, as the default of `RISU_ASSET_GRACE_DAYS`
  (minimum 1). A shorter default saves little (the clocks only start at the first complete scan) and shrinks
  the window in which a restore of a deleted chat still finds its inlays. The alternative, no grace with the
  recheck alone, is rejected by the adopted policy.
- **Q2. Automatic deletion in scope.** Recommended: not in this plan's slices; the daily scan is automatic and
  read-only, deletion is the user's click on a report they have seen. If the owner wants the opt-in sweep now,
  it is the `assetAutoSweep` field of D10 in Slice 2, default off, with the same fail-closed rules, and the
  report shows the last automatic sweep's result.
- **Q3. Pinned snapshots and the count of 20.** Recommended: pinned snapshots do not count toward the 20
  rotated ones and are capped at 20 themselves, so the worst case is 40 database copies, each at most the
  database's size. The alternative, pins inside the 20, means a user who pins 20 snapshots stops the periodic
  snapshot silently.

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Slices 2 and 3
both edit `server/src/routes/backups.ts` and `server/src/data/snapshots.ts`: not in parallel.

### Slice 1: the mark, the ledger, the report (D1, D2, D3, D4, D5, D9's route, D12's helper; needs nothing)

Files: new `server/src/data/assetLifecycle.ts` (the lifecycle database, the live scan in one read
transaction, the per-snapshot index, the typed attribution walk over `collectAssetReferences` extended with
inlays and owner ids, the run record, the daily scan), new `shared/assetLifecycle.ts` (the report shape, the
route paths, `ASSET_LEASE_MS`, the grace default), new `server/src/routes/assetLifecycle.ts`
(`GET /api/assets/report`, `POST /api/assets/scan`, `checkAuth`, no-store, the storage limiter), new
`server/src/http/diskSpace.ts` (`freeBytes`), `server/src/routes/backupsUpstreamExport.ts` (`heldAssetKeys()`),
`server/src/routes/backups.ts` (`listAssetKeys` gains sizes and the unmanaged list, or a sibling
`listAssetFiles`), `server/src/data/snapshots.ts` (nothing new: `list` and `resolve` are what the index
reads), `server/src/app.ts` (wiring, the daily scan beside the thumbnail sweep, `dispose` waits for a running
scan), the self-host server guide (Storage routes, Disk layout: `data/asset-lifecycle.sqlite`, Process memory,
Flows: the mark), the server resources guide (State: the snapshot reference index; the Issues entry about
retained snapshots becomes a Limitation naming D3 until Slice 2 removes it), `docs/audit/asset-scan-<date>.md`
(the scan's cost on a seeded store).

- Tests (new `server/src/tests/assetLifecycle.test.ts` with a seeded store, real snapshot files, and an
  injected clock; `server/src/tests/backups.test.ts`; `server/src/tests/app.test.ts`): a key named only by a
  typed field, only by `{{inlayed::assets/…}}` in a message, only by a checkpoint page, only by a snapshot,
  only by a prepared export, and only by a young file is referenced, and a key named by none is unreferenced
  with `since` set once; a referenced key leaves the ledger; a snapshot is scanned once and its set reused
  while a new snapshot is scanned on the next run; a snapshot that cannot be opened makes the run incomplete
  with the reason, writes nothing to the ledger, and still reports sizes; an unmanaged file name is counted
  and never a candidate; logical, deduplicated, and owner bytes for a shared profile image; inlay attribution
  to the chat's character; `heldBytes` of a snapshot that alone names a key; the routes need auth, answer
  no-store, and `scan` is a 409 while a run is on; the daily tick skips under maintenance; `freeBytes` with an
  injected `statfs`.

### Slice 2: deletion with grace, lease, lock, recheck, and the disk preflight (D6, D7, D12; needs 1)

Files: `server/src/data/assetLifecycle.ts` (the sweep: batches under `snapshots.exclusive`, the re-mark on a
moved `writeCount`, the per-key recheck and delete), `server/src/routes/assetLifecycle.ts`
(`POST /api/assets/sweep`), `server/src/routes/storage.ts` (the lease bumps in `/api/assets/missing` and
`/api/asset/*`, the `assetLocks` map around both publish renames, shared with the sweep), new
`server/src/http/assetLeases.ts` (the bounded lease map, if `storage.ts` would grow past its budget),
`server/src/routes/backups.ts`, `server/src/routes/backupsUpstream.ts`, `server/src/routes/backupsUpstreamExport.ts`,
`server/src/data/snapshots.ts` (the preflights of D12), `src/ts/process/files/inlays.ts` (the header and
`removeInlayAsset`'s comment: blobs are deleted by the server's sweep once unreferenced past the grace
period, never here), the self-host server guide (Storage routes, Flows: the sweep and the lease, Invariants:
a publish and a delete of one key serialize on its lock, Known Hazards: the D11 Limitation; the thumbnail
cache's "no byte cap" Issue stays), the server resources guide (the Issues entry about retained snapshots
deleted; Maintenance: the sweep's batches use `exclusive`, not maintenance; the restore's and imports'
preflight), the global API guide (Asset client: a present answer from the missing check is a one-hour lease).

- Tests (`server/src/tests/assetLifecycle.test.ts`, `assets.test.ts`, `assetRoute.test.ts`, `backups.test.ts`,
  `snapshots.test.ts`, with injected clock and `statfs`): a candidate past both clocks is deleted with its
  thumbnail directory and verification entry, and the ledger row goes; a candidate whose file was republished
  (young mtime) is skipped with the reason; a key the missing check answered present within the hour is
  skipped; a key referenced by a write that landed after the mark is skipped because the re-mark sees it; a
  publish that arrives while the sweep holds the key's lock lands after the delete and leaves the new file
  (the lock test with a latch); an incomplete or stale run makes `sweep` a 409; `dryRun` deletes nothing and
  answers the same list; `keys` narrows the run; a filesystem error on one key is a skip, not a 500, and the
  batch continues; the restore, the imports, and the export prepare answer 507 with `{ needed, free }` from
  a short injected `statfs` and write no staging; the snapshot tick skips and logs once on a short disk and
  resumes when space returns.

### Slice 3: snapshot pins, labels, manual snapshots, deletion (D8; needs 1, after 2)

Files: `server/src/data/snapshots.ts` (`pins.json`, `setPinned`, `remove`, `snapshotNow({ label })`,
retention over unpinned snapshots, `list` with `pinned` and `label`, `pin` → `stageCopy`),
`server/src/routes/backups.ts` (`POST /api/backups/snapshot` `{ label? }`, `PATCH /api/backups/:id`
`{ pinned?, label? }`, `DELETE /api/backups/:id`, the restore's `stageCopy`), `server/src/data/assetLifecycle.ts`
(a removed snapshot's index rows go with it; pins change nothing in the mark, since every listed snapshot
is a root),
`shared/resources.ts` (`BackupSnapshotInfo`), `src/ts/storage/resourceClient.ts` (`takeSnapshot`,
`updateSnapshot`, `deleteSnapshot`), the server resources guide (Snapshots and restore: pins and the cap;
Files; Recipes), the persistence guide only if `BackupSnapshotInfo`'s mention there changes.

- Tests (`server/src/tests/snapshots.test.ts`, `backups.test.ts`, `src/ts/storage/tests/resourceClient.test.ts`):
  retention keeps 20 unpinned snapshots and every pinned one; the 21st pin is a 409; deleting a pinned
  snapshot is a 409 and an unpinned one removes the file, its pin entry, and its index rows; a manual
  snapshot carries its label and counts toward the unpinned 20 until pinned; a pin whose file is gone is not
  listed; the restore still works through `stageCopy` while retention runs; the client calls send the right
  methods and bodies.

### Slice 4: the Storage section of Advanced settings (D9's UI; needs 2 and 3)

Files: new `src/lib/Setting/Pages/Advanced/StoragePanel.svelte`, new `src/ts/storage/assetLifecycleClient.ts`
(`readStorageReport`, `startStorageScan`, `sweepAssets`, over `authFetch`), `src/ts/setting/customComponents.ts`,
`src/ts/setting/advancedSettingsData.ts` (section `advanced.storage` with the custom item), `src/lang/en.ts`
and `src/lang/ko.ts` (`storage.*`: the totals, the owner kinds, the candidate list, the confirmations naming
count and bytes, the snapshot actions, the "shares may exceed the total" note, the incomplete-run notice),
the settings and i18n guide (Declarative pages: the section; Tests), the global API guide (Files: the client).

- Tests (new `src/lib/Setting/Pages/Advanced/StoragePanel.test.ts` on the `DiagnosticsPanel.test.ts` pattern,
  new `src/ts/storage/tests/assetLifecycleClient.test.ts`, `src/ts/setting/settingsPageSections.test.ts`,
  `e2e/settingsPages.spec.ts`): the panel reads the report on open and shows totals, shares, candidates, and
  snapshots; Scan starts a run and polls until `running` clears; an incomplete run disables Delete and shows
  the reasons; Delete confirms with the count and bytes, sends the selected keys, and shows the skipped keys
  with their reasons; the snapshot actions call the client with the right ids; Pin on the 21st shows the
  server's refusal; the section mounts through the records without a write (the e2e page sweep).

### Slice 5: the browser check and the final guide pass (needs 4)

Files: new `util/playwright/checkAssetLifecycle.mjs` (listed in the test-harness guide's Check scripts beside
`checkDurableDrafts.mjs`; it reuses `stack.mjs` and the settle helpers), a final pass over every guide this
plan touched, the audit note of Slice 1 extended with the sweep's cost.

- Driver cases, one dev stack with `RISU_ASSET_GRACE_DAYS=0` passed to the server for the deletion steps
  only: seed a character with a profile image and a chat with a generated inlay; the report attributes both;
  delete the character; Scan shows the two keys as unreferenced and, with the grace at its default, not yet
  deletable; with the grace at zero and an hour-old lease cleared by a server restart, Delete removes them and
  the thumbnail directories; a tab that rendered the image before the delete still shows it from its cache
  and shows a broken image after a reload (D11); a pinned manual snapshot taken before the delete keeps a
  third key alive through a Scan, and unpinning and deleting the snapshot frees it; the restore of that
  snapshot before its deletion brings the character back with its image intact.
- Device checks (a Docker volume on a nearly full disk for the 507 answers) go to the user as a checklist and
  are reported as not run (V5).

## Recommended order

1 → 2 → 3 → 4 → 5. Slice 1 is invisible to the tab (a new read-only route and a nightly read-only scan) and
starts the grace clocks, so the day Slice 2 lands there are already deletable keys to test against. Slice 3
could go before Slice 2 if the owner wants pins first; both edit `backups.ts`, so one at a time. Slice 4 is
the first user-visible change. If Q2 says automatic deletion now, it rides in Slice 2.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for the renamed export (`pin` → `stageCopy`) and
  for `listAssetKeys` if its shape changes, V6 for every new test (shown failing once with the guarded line
  broken).
- Focused: `pnpm --silent test:agent server/src/tests/assetLifecycle.test.ts server/src/tests/snapshots.test.ts
server/src/tests/backups.test.ts server/src/tests/assets.test.ts server/src/tests/assetRoute.test.ts
server/src/tests/app.test.ts` for the server;
  `pnpm --silent test:agent src/lib/Setting/Pages/Advanced/StoragePanel.test.ts src/ts/storage/tests/assetLifecycleClient.test.ts
src/ts/storage/tests/resourceClient.test.ts src/ts/setting/settingsPageSections.test.ts` for the tab (file
  names as the slices create them).
- `e2e`: `e2e/settingsPages.spec.ts` after Slice 4 (every settings page mounts without a write); the
  slow tests of the backup routes if `backups.test.ts` gains a `slow` case for a large seeded store (then
  `pnpm check:tests` for the slow-test table). Browser: `util/playwright/checkAssetLifecycle.mjs` after
  Slice 5, one dev stack at a time.
- Not covered by any gate: the full-disk answers on a real volume (the user's checklist), and the scan's
  cost beyond the one measurement the audit note records.

## Out of scope

- A byte budget over snapshots, thumbnails, or assets that deletes referenced data to make room (F08's
  budget), and a byte cap on the thumbnail cache (its Issue stays).
- The tab's fallback asset path (F13): it reads originals without a capable worker; unchanged here.
- Snapshot content browsing, diffs, and per-record restore (HaejeokRisuai C3), and snapshot download as an
  archive (RisuNest item 8's download; the version-2 export covers a live export).
- `store.checkpoints.sweep`'s missing caller: a deleted chat's pages are bytes inside `resources.sqlite`, not
  assets; the found-issues entry stays where it is, and a maintenance tick that calls it would be a one-line
  follow-up once this plan's daily tick exists (**Later**).
- Retiring `GET /api/remove`: no client calls it, but it is the one explicit delete the tests and the
  thumbnail removal path use; it stays.
- Multi-user servers: the report and the sweep act on the one user's data behind the JWT.

## Later

- The opt-in automatic sweep (`assetAutoSweep`, D10) if Q2 defers it.
- A daily snapshot tier (keep one per day for D days) beside pins, if the 10-minute cadence and 20 kept
  rotate away states users want.
- Calling `store.checkpoints.sweep` from the daily tick, so a long-running server frees a deleted chat's
  pages without a restart.
- Live progress of a scan or sweep over the live-update feed instead of polling, if runs on large stores
  take long enough to need it.
- Thumbnail-sized delivery on the fallback path (F13), which would let the report's thumbnail bytes mean the
  same thing in every environment.
