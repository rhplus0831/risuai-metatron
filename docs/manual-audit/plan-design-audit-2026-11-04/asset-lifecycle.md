# Audit: docs/plan/asset-lifecycle.md (tree at d31fa9a48)

Ranked, most severe first. Plan line numbers are from `cat -n docs/plan/asset-lifecycle.md`.

## 1. Server-side imports re-reference an old key without a lease, lock, or young file

- Severity: P1 design flaw
- Plan: D3 (lines 143-147, "generation jobs ... young file"; "an imported archive's assets are young"), D7 (177-188: "Youth ... covers every write that publishes a file"; the lock covers "`writeStorageFile`'s rename and the batch route's per-record rename")
- Evidence:
  - `server/src/http/contentAsset.ts:35` `if (fullPath === null || !(await holdsVerifiedAsset(fullPath, hashHex)))`: CharX (`importCharx.ts:186`) and the PNG reader (`importPng.ts:212`) skip the write when the file already holds the bytes. Nothing is published, so the old mtime stays, no lease is bumped, and no lock is taken. The import's record that names the key commits later.
  - `server/src/routes/importModule.ts:125` follows the same pattern (`holdsVerifiedAsset` skip).
  - These imports use the import slot, not `snapshots.exclusive` (no `exclusive(` call in importCharx/importPng/importModule), so they interleave with D6's sweep batches. The re-mark cannot see a record that has not committed yet.
  - `server/src/http/contentAsset.ts:78` `await fs.rename(stagedPath, fullPath)` (`publishStagedContentAsset`, used by `importPng.ts:230`) is a third rename into `save/assets/` outside both paths D7 locks. The plan's statement that "a publish and a delete of one key never interleave" is false for it. (`backups.ts:507` rename and the `fs.link` beside it run under maintenance, so `exclusive` already serializes them.)
- Scenario: a user re-imports a card whose image was unreferenced past the grace period while a sweep runs. The import sees "present" and skips the write, the sweep deletes the file, and then the character record commits naming a missing key.
- Correction: route every "already holds these bytes" decision (`holdsVerifiedAsset` callers) and every rename or link into `save/assets/` through one `storage.ts` helper. The helper takes the per-key lock and bumps the lease, the same as a "present" answer from `/api/assets/missing`. Also list `publishStagedContentAsset` in D7's lock.
- Confidence: verified

## 2. A restart reopens the lease window and the cross-process run check

- Severity: P1 design flaw
- Plan: D7 (185-186: "The lease is lost at restart, which is acceptable: the first scheduled scan is an hour after start, a manual sweep needs a complete run no older than an hour"), D6 (167-170: "requires the latest run to be complete and no older than one hour ... if `store.writeCount()` moved since the mark"), Slice 5 (364: "an hour-old lease cleared by a server restart, Delete removes them")
- Evidence:
  - `POST /api/assets/scan` (D9, line 210) lets the user start a complete run right after a restart. The scheduled scan's delay therefore bounds nothing: a tab that got "present" just before the restart and writes its record just after loses the file to a scan-then-sweep. Slice 5 uses exactly this restart to get past the lease.
  - `server/src/data/resourceStore.ts:966-967` says `/** Committed writes since the store opened ... */ let writeCount = 0;`, so the counter starts again in each process. A `runs` row persisted by the previous process (D4, line 150) and compared against the new process's `writeCount` can match by accident, and then the stale ledger is swept with no re-mark. The same is true after the database is replaced while the server is down (`app.ts:385` handles that case for the vector cache with `vectorCache.sync(resources.epoch())`).
- Correction: allow a sweep only from a complete run made by this process on the current epoch. Store the epoch and a process id in `runs`, and refuse with 409 until the process has been up for at least `ASSET_LEASE_MS`. Slice 5 should then use an injected lease length, not a restart.
- Confidence: verified (the logic and the counter); the persisted-run comparison depends on how Slice 2 reads `runs`

## 3. D2's key token has no terminator, so the mark can miss keys (fails open)

- Severity: P1 design flaw
- Plan: D2 (129-138: "`assets/<name>` where `<name>` is a character run the file-name codec accepts")
- Evidence:
  - `server/src/routes/storage.ts:82-103`: `encodeFileName` percent-encodes every byte that is not `[a-z0-9._-]` and accepts any non-empty name of up to 255 encoded bytes, so "a run the codec accepts" never ends. A greedy run takes in the closing quote, `}}`, `)` or the following text and names a different key, and the real key is never marked.
  - Keys with arbitrary characters exist. `src/ts/globalApi.svelte.ts:411-414` takes the extension from `fileName.split(".").pop()` verbatim (spaces, uppercase, or a whole dot-less file name). Upstream imports keep their own names. Only content names are restricted (`assetVerification.ts:38`).
- Correction: match against the keys actually on disk, not against tokens. For each `assets/` occurrence, keep the following tail of at most 255 bytes. A disk key is referenced when some tail starts with its name. Store the tails, not parsed keys, in `snapshotRefs`, so a key uploaded after indexing still matches.
- Confidence: verified

## 4. D1 leaves out `chats.meta` and most memory tables, which hold free text

- Severity: P1 design flaw
- Plan: D1 (119-122: "every `resources` row, every `messages` row, every `checkpointPages` row, and the structured memory page tables"), D2 (133-134: "lorebook or module text that pasted a key")
- Evidence:
  - `server/src/data/chatStore.ts:58-66`: `chats(... meta TEXT NOT NULL ...)`.
  - `chatStore.ts:662`: `serialize(normalizeChatMeta(withoutProjection(chat), chatId))`. The whole chat except its messages is stored there: `localLore`, `scriptstate` (Lua variables), `note`, `hypaV3Data`, `bookmarks` and more (`shared/chatCheckpoints.ts:7-19`). A key pasted into chat-local lore, or stored in a chat variable by a script, is in no scanned table.
  - Memory tables beyond "page tables": `memory_events`, `memory_threads`, `memory_runs` and the `memory_staged_*` tables (`chatStore.ts:163-262`).
- Correction: scan every TEXT column of every table in both the live and the snapshot layouts, at least `chats.meta`, all `memory_*` tables (staged included) and `chatCheckpoints.fields`. Add a Slice 1 test for "a key named only in a chat's `localLore`" and one for "only in `scriptstate`".
- Confidence: verified

## 5. "One read transaction" has no workable form on the store's single `node:sqlite` connection

- Severity: P1 design flaw (as written)
- Plan: D1 (120: "reads the live store in one read transaction"); D6's re-mark (169-170)
- Evidence:
  - `resourceStore.ts:5` imports `DatabaseSync` from `node:sqlite`, which is synchronous only. The store holds one connection (`resourceStore.ts:825`) in WAL mode (`:3327`), and writes open with `BEGIN IMMEDIATE` (`:969`).
  - A read transaction held open across awaits on that connection makes every concurrent write's `BEGIN` fail (a transaction inside a transaction). Run synchronously instead, the whole scan blocks the event loop, and so does the re-mark inside each `exclusive` sweep batch.
  - No module opens a second connection to the live database today (`rg "new DatabaseSync\("`).
- Correction: state that the mark opens its own read-only connection to `data/resources.sqlite` (WAL lets it read a consistent snapshot while writes go on) and walks it in chunks with yields. Close it on dispose. Bound the WAL growth a long reader causes. Alternatively, scan a `backupTo` copy, at the cost of disk space.
- Confidence: likely (verified that the plan names no connection; the failure modes follow from the binding)

## 6. Inlay records are unconditional roots, which contradicts Slice 5 and the reroll plan

- Severity: P2 contradiction and design gap
- Plan: D3 (140: "including `inlays` records"), D9 (208-209: attributed "to `inlays` when no chat does"), Slice 5 (362-364: "a chat with a generated inlay ... delete the character; Scan shows the two keys as unreferenced")
- Evidence:
  - Deleting a character never removes `inlays` records. The only caller of `removeInlayAsset` is `src/lib/Playground/PlaygroundInlayExplorer.svelte:57,76`, and the server's `inlays` kind (`kinds.ts:181-203`) has no cascade. Under D3 the inlay's media stays referenced forever, so Slice 5's driver step cannot pass, and generated images (the main growth source) are never reclaimable.
  - `docs/plan/reroll-candidates.md:197-199` expects this plan to "count inlay references inside non-selected candidates", which means following inlay ids.
  - D2's "catches `{{inlayed::assets/…}}`" protects the wrong file. `server/src/lua/bindings.ts:1658-1663` uses the character image key as the inlay _id_; the media that renders is the record's own `asset` (`assets/inlay_<sha>.png`, `bindings.ts:243-246`).
- Correction: make an `inlays` record reachable only through its id. Scan text for `{{inlay::ID}}`, `{{inlayed::ID}}` and `{{inlayeddata::ID}}` (candidates included), and treat a reached record's `asset` as referenced. An unreached record's media becomes a candidate (and optionally the record too), or the slice says plainly that inlays are out of scope and Slice 5 changes.
- Confidence: verified

## 7. Snapshot reads race rotation, and the re-mark skips new snapshots

- Severity: P2 design flaw
- Plan: D1 (122-124: "computed once ... stored by snapshot id"), D5 (159-161: "a listed snapshot that cannot be opened ... `complete: false`"), D6 (170: "snapshot sets are already indexed"), Slice 1 (272-273: "`list` and `resolve` are what the index reads")
- Evidence:
  - `snapshots.ts:90-113`: `list()` and `resolve()` are plain `readdirSync`/`lstatSync` calls with no lock. `takeLocked` removes old files under `exclusive` (`:153-155`). A tick between the mark's `list()` and its open turns a rotated snapshot into a false "incomplete". `pin()` (`:120-137`) exists for exactly this race.
  - A snapshot taken between the mark (up to one hour old) and the sweep is not indexed when D6 re-marks only the live store. It can name a key that a write after the mark added and a later write removed.
  - A snapshot that can never be opened makes every run incomplete, so the sweep is blocked until the user deletes that snapshot (Slice 3).
- Correction: index each unindexed snapshot from a hard link taken through `snapshots.pin`/`stageCopy`. A snapshot that left the listing during the scan counts as gone, not as unreadable. At the start of each sweep batch (under `exclusive`), list the snapshots again and index any new ones. The report's reasons should name an unreadable snapshot and offer to delete it.
- Confidence: verified (code paths); the sweep scenario is narrow

## 8. The SQL prefilter drops the `/api/asset/<hex>` form that D2 counts

- Severity: P2 contradiction
- Plan: D1 (121: "prefiltered in SQL with `instr(text, 'assets/') > 0`") vs D2 (131-132: "every `/api/asset/<hex>` whose hex decodes to such a key, is a reference")
- Evidence: a direct URL (`src/ts/globalApi.svelte.ts:175`, `"/api/asset/" + hex`) holds only `asset/` followed by hex, never the substring `assets/`, so the prefilter skips the row.
- Correction: prefilter on `instr(text,'assets/') > 0 OR instr(text,'/api/asset/') > 0`.
- Confidence: verified

## 9. Orphan checkpoint pages keep a deleted chat's assets until a restart

- Severity: P2 contradiction
- Plan: D1 (121: "every `checkpointPages` row"); Out of scope (405-407: "a deleted chat's pages are bytes inside `resources.sqlite`, not assets")
- Evidence:
  - `checkpointStore.ts:46-48`: "the table-wide sweep at open collects the rest, such as the pages a chat's cascade left unreferenced". The only product sweep runs at open (`resourceStore.ts:1301`).
  - After a chat or character is deleted, its pages still hold the message text, so D1 marks its assets until the next restart. This is a second reason Slice 5's "delete the character; Scan shows the two keys as unreferenced" can fail when the chat had a checkpoint.
- Correction: scan only pages that a `checkpointPageRefs` row names (`WHERE EXISTS (SELECT 1 FROM checkpointPageRefs r WHERE r.hash = checkpointPages.hash)`), in the live store and in snapshots, or call `store.checkpoints.sweep()` at the start of each run (which pulls that Later item in). Correct the Out of scope reason either way.
- Confidence: verified

## 10. The grace floor is below the draft journal's TTL, and Slice 5 sets it to 0

- Severity: P2 contradiction
- Plan: Q1 (245-246: "`RISU_ASSET_GRACE_DAYS` (minimum 1)") vs Slice 5 (361: "`RISU_ASSET_GRACE_DAYS=0` passed to the server"); D3's roots have no client-held state
- Evidence:
  - `src/ts/storage/draftJournal.ts:75`: `JOURNAL_ENTRY_TTL_MS = 48 * 60 * 60 * 1000`. A journaled mutation or a recovery draft (browser IndexedDB, `docs/structure/draft-recovery.md:28`) can name an asset uploaded with it and replay up to 48 h later. With a 1-day grace, that file can already be gone.
  - Plugin v3 `saveAsset` (`src/ts/plugins/apiV3/v3.svelte.ts:1716-1719`) returns a key that a plugin may keep only in its `safeLocalStorage` (`:1472`), which no root reaches. Unverified whether any plugin does this.
- Correction: set the floor above the journal TTL (for example 3 days). Give the driver a test-only injected grace rather than an env value of 0. Add a D11-style Limitation: keys held only in browser state (the journal after its TTL, plugin local storage) are not roots.
- Confidence: verified (constants and text); the plugin case is unverified

## 11. A one-hour lease can lapse during a long batch import

- Severity: P2 design flaw
- Plan: D7 (179-182: lease bumped when the missing check answers present, kept `ASSET_LEASE_MS` (one hour))
- Evidence: `src/ts/storage/assetClient.ts:394-430` (`writeAssets`) runs one missing check for every candidate up front, then uploads the remaining batches one request at a time. The caller (`assetQueue.ts:332` and the bulk import paths) writes the records naming the skipped keys only after all uploads finish. On a slow link with many assets, the gap can exceed one hour.
- Correction: refuse a sweep (409) while any missing check or asset write happened within `ASSET_LEASE_MS`, or bump every lease again on each later write in the same request sequence. Since the sweep is user-started, the quiet-period rule is the simplest.
- Confidence: likely (the code path is verified; real durations are not measured)

## 12. The export root misses in-flight exports

- Severity: P2 (low impact while the grace stands)
- Plan: D3 (141-142: "every prepared upstream export until its download, cancel, or TTL (`heldAssetKeys()`)"); D5 (160: "the export staging not answering"); Current state (96-97: the version-2 export "holds nothing between requests")
- Evidence:
  - A download detaches the export before it streams (`backupsUpstreamExport.ts:128-131` `take` → `detach`; `:388-397` streams `staged.assets` afterwards), so `waiting` no longer holds it.
  - A prepare does not know its keys until its worker ends (`:227-270`).
  - The version-2 export streams files for the whole request after an `exclusive` copy (`backups.ts:223`).
  - `staging` is synchronous and in memory, so it cannot be "not answering".
- Correction: cover exports that are preparing, staged or downloading, plus version-2 exports in flight. Make the run incomplete, or answer `sweep` with 409, while any of them runs. Drop the "not answering" reason.
- Confidence: verified (code); impact requires one of findings 1, 2 or 11

## 13. The slice dependency headers disagree with the Recommended order

- Severity: P2 contradiction
- Plan: Slice 3 header (319: "needs 1, after 2") vs Recommended order (375-376: "Slice 3 could go before Slice 2 if the owner wants pins first"); 260-261: "Slices 2 and 3 both edit `backups.ts` and `snapshots.ts`" (Slice 1 also edits `backups.ts`, line 271)
- Also: Slice 1 (275-276) turns the Issues entry into a Limitation "until Slice 2 removes it", but Slice 2 (303-304) deletes "the Issues entry", which no longer exists by then.
- Correction: change Slice 3's header to "needs 1; not in parallel with 2" (D8 does not depend on D6 or D7). Have Slice 2 remove the Limitation that Slice 1 wrote.
- Confidence: verified

## 14. The D12 disk estimates do not match what restore and import write

- Severity: P3 wrong claim
- Plan: D12 (231-236: restore needs "twice the snapshot's size: the safety snapshot and the install"; imports answer 507 "before any staging is written")
- Evidence:
  - A restore writes a staged store file (`backups.ts:149-153`, `restoreRunner` → `stagedFile`) and a safety snapshot of the _live_ database (`withMaintenance` → `takeLocked` → `store.backupTo`, `snapshots.ts:145`). The install then copies in place inside a WAL transaction (`replaceAll`, `resourceStore.ts:2864`). The estimate is about 2 × snapshot + live size, not 2 × snapshot.
  - `POST /api/backups/import` spools the whole archive (`backups.ts:396-405`, `spool(body, archiveFile, …)`) before it can learn the database size or the asset list.
- Correction: estimate a restore as the staged file (≈ snapshot), plus a safety snapshot (≈ live), plus install growth (≈ snapshot). For the import, check the declared `Content-Length` first (archive plus database copy plus staged store), then check again after `planImport` for the assets that are not on disk yet.
- Confidence: verified

## Checked and found sound

- `writeStorageFile` stages under `save/.tmp/` and publishes by rename (`storage.ts:213-221`), and `/api/write` uses it (`:725`). The batch route renames each record into place (`:810`). `/api/remove` has no client caller and calls `forgetVerification` and `thumbnails.removeKey` (`:625-668`). `enterMaintenanceGate` admits a write that maintenance then waits for (`:450-460`, `snapshots.ts:191-215`).
- The missing check answers only for content-named keys (`storage.ts:907-913`), and `saveAsset` skips the upload on "present" (`globalApi.svelte.ts:381-388`).
- `DEFAULT_KEEP = 20` and the `list().slice(keep)` rotation (`snapshots.ts:10,153-155`). `pin` is a hard link taken under `exclusive` (`:120-137`). `withMaintenance` lives in `snapshots.ts` and runs the listeners first (`:271-291`).
- WAL mode (`resourceStore.ts:3327`). `replaceAll` bumps `writeCount` (`:2912`) and memory writes count (`:1988-1991`), so an in-process restore or import triggers D6's re-mark. A key held only by a snapshot never enters the ledger, so rotating that snapshot during a restore starts a fresh grace clock. "Restore and import need no special root" holds within one process (subject to finding 2).
- `generation-jobs.sqlite` is `save/data/generation-jobs.sqlite` and holds job receipts only (`app.ts:353-357`). D4's location is right, and the file is not a root.
- The structured memory tables exist (`chatStore.ts:163-262`). Checkpoint pages hold message `data` verbatim, plus the captured chat fields and memory chunks (`checkpointStore.ts:384-407`).
- The Lua `getCharacterImageMain` / `getPersonaImageMain` return `{{inlayed::<image key>}}` (`bindings.ts:1653-1674`).
- `collectAssetReferences` walks the fields the plan lists (`assetReferences.ts:41-74`, `85-108`).
- `UPSTREAM_EXPORT_STAGED_TTL_MS` is 10 minutes (`shared/upstreamExportReport.ts:107`).
- The thumbnail sweep runs after listen (`app.ts:1080-1085`); `removeKey` is at `assetThumbnails.ts:345`.
- `store.checkpoints.sweep` has no product caller (`resourceStore.ts:1957`); the sweep runs at open (`:1301`).
- `BackupSnapshotInfo` is `{ id, createdAt, size }` (`shared/resources.ts:553`), and `loadInternalBackup` is at `globalApi.svelte.ts:1228`.
- The `advancedSettingsSections` custom-item and `DiagnosticsPanel` pattern exists (`advancedSettingsData.ts:267-284`, `customComponents.ts:22,39`), and so does the `readProviders` / `requestHistoryLimit` pattern (`app.ts:392-399`).
- No product module calls `statfs` (only a test fixture does). `engines.node >=24.0.0`, so `fs.statfs` is available.
- The inlays header policy and `removeInlayAsset` deleting only metadata (`inlays.ts:23-29,619-641`).
