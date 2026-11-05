# Asset Lifecycle Plan

Status: drafted 2026-11-03, revised 2026-11-04 after the design audit and again after its adversarial challenge
([plan design audit](../audit/plan-design-audit-2026-11-04.md), items AL1–AL5, X7, X8, and the same day's
independent cross-audit of the sweep's check-to-unlink gap; the challenge's findings are cited as "challenge
F1"–"F6"); landed: 1 (`b7095d591`), 2 (`dd35ebc52`), 3 (`0c3e7d2d0`), 4 (`967cc5be1`). Decisions D1–D14 are recommendations for the owner; the **Open questions** Q1–Q3
were answered by the owner on 2026-11-03 (the recommended option each time; Q1's minimum is superseded by D4's
3-day floor). Code anchors re-checked at `1550ebdd3`; verify them again before editing (STRUCTURE.md protocol
step 5).

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
(asset lists are immutable tuples; keys are on-disk names), and [assets](../structure/assets.md) (Asset
sources, Asset client).

Owning guides when sliced: [self-host server](../structure/self-host-server.md) (the report, scan, and sweep
routes, the lifecycle database, the lease, the per-key publish contract, the sweep's synchronous turn, the
disk preflight), [server resources](../structure/server-resources.md) (snapshot pins and labels, manual
snapshots, deletion, the per-snapshot reference index, the roots a restore or an import adds),
[assets](../structure/assets.md) (the client calls), [settings and i18n](../structure/settings-i18n.md)
(the Storage section of Advanced settings), [test harness](../structure/test-harness.md) (the browser check).

Relation to completed plans (see [the archive](../archived-plan/README.md)): Direct Asset URLs made
content-named assets immutable in the browser cache, which D11 accounts for; Server Thumbnails added the
derived cache that D3 treats as a non-root removed with its key; Large Asset Import and Export added the batch
write that publishes by rename, which D7 relies on; Server Byte Budgets bounded request and restore memory but
left disk use unreported (F08). None of them is re-proposed.

Relation to active plans: [Reroll Candidates](reroll-candidates.md) keeps a reply's alternatives in the
message row as `candidates[].data`; the row's JSON is one `messages.data` text, so D1's string scan covers a
non-selected candidate's keys and inlay ids without naming the field, and Slice 1 tests it.
[Incremental Chat Transport](incremental-chat-transport.md) adds a `changes` log to `resources.sqlite` (up to
about 4 MB at its 20,000-row bound), which every snapshot copies: the 40 copies D8 and Q3 allow hold up to
160 MB of it. Slice 3 shares `shared/resources.ts` with Transport Slices 1, 3, and 4 and
`src/ts/storage/resourceClient.ts` with Transport Slices 3 and 4, and Slice 2 shares
`server/src/data/resourceStore.ts` with Transport Slices 1 and 3: neither runs in parallel with those.

## Goal

The server can tell which stored assets are still referenced, report where the disk goes, and remove
unreferenced assets safely:

- One retention graph: live records, every retained snapshot, chat checkpoints, prepared exports, and recent
  uploads are roots; an asset no root names is unreferenced. Snapshot count, checkpoint pruning, and export
  staging stop being independent counters that each hold assets without knowing it.
- A report the user can read: logical size (every reference counted), deduplicated size (what is on disk),
  the savings between them, shares per character, module, persona, and settings, unreferenced bytes, bytes
  past the grace period, inlay records nothing names, and the disk's free space, beside the snapshot list
  with sizes and the bytes each snapshot alone holds.
- Deletion that fails closed: nothing is deleted while any root cannot be read in full, nothing younger than
  the grace period is deleted, the dry run is the report itself, each delete is rechecked right before it, and
  the user starts it.
- Snapshots a user can pin, label, take, and delete, so "keep the state before I try this module" is cheap and
  a pinned snapshot keeps its assets for as long as it exists.

Not goals: a byte budget that deletes referenced data or rotates pinned snapshots, deleting thumbnails
separately from their source, snapshot content browsing or per-record restore (HaejeokRisuai C3), compaction
of `resources.sqlite`, multi-user servers.

## Current state

The baseline is `1550ebdd3` on `dev` (2026-11-04; first drafted against `8f0db0fb7`). This plan does not
re-propose it.

- **Assets are content-named files that nothing deletes.** A logical key `assets/<sha256>.<ext>` (or
  `assets/inlay_<sha256>.<ext>`, or a custom id) lives at `save/assets/<encodeFileName(name)>`
  (`server/src/routes/storage.ts`, `resolveStorageKey`; the codec, around 46 and 82–118, stores a name of at
  most `MAX_FILE_NAME_BYTES`, 255). The codec accepts any UTF-8 name, quotes, backslashes, and control
  characters included (`saveAsset` in `src/ts/globalApi.svelte.ts` takes a custom id), while the store writes
  every JSON column as `JSON.stringify` output (`serialize`, `server/src/data/resourceStore.ts` around
  3238–3268), which escapes `"`, `\`, and control characters: such a key's raw column text is not the key.
  `/`, letters, and digits are never escaped. Writes stage under `save/.tmp/` and publish by rename
  (`writeStorageFile`; the batch route `POST /api/assets/write` the same, record by record). The only delete is
  `GET /api/remove`, which no client calls. `src/ts/process/files/inlays.ts` states the policy at its header:
  committed blobs are never deleted because retained snapshots may reference them, and `removeInlayAsset`
  deletes only the metadata record. The inlay writer relies on that policy: `storeMedia` (around 316–329)
  uploads only when the tab's in-memory `blobCache` lacks the key, which no metadata delete clears, and
  `writeMedia` (around 331–345) then writes the record. `removeInlayAsset`'s only caller is the Playground
  inlay explorer (`src/lib/Playground/PlaygroundInlayExplorer.svelte`); deleting a character removes its chats
  and the character (`server/src/data/resourceStore.ts` around 2460), never an `inlays` record.
- **Imports reuse files without writing them.** `writeContentAsset` (the CharX, PNG, and Realm card imports)
  and `publishStagedContentAsset` (the PNG reader's staged image, which otherwise publishes by a rename of its
  own) in `server/src/http/contentAsset.ts` (around 35–46 and 67–78), and the module import
  (`server/src/routes/importModule.ts` around 125–136), skip the write when the file already holds the bytes
  (`holdsVerifiedAsset`): the file keeps its old mtime, and these imports run outside `snapshots.exclusive`.
  The backup and upstream imports skip or repair existing files inside `withMaintenance`
  (`server/src/routes/backups.ts` around 480–515).
- **Snapshots are retained by count.** `server/src/data/snapshots.ts` keeps the newest 20 `resources-*.sqlite`
  files under `save/backups/` (`DEFAULT_KEEP`, `takeLocked`'s `list().slice(keep)` loop); a snapshot copies the
  resource database, never assets, so every retained snapshot holds asset references nothing counts. There is
  no pin, label, manual snapshot, or delete; `BackupSnapshotInfo` is `{ id, createdAt, size }`
  (`shared/resources.ts`), and the tab's `loadInternalBackup` (`src/ts/globalApi.svelte.ts`) lists dates and
  restores. The manager's `pin(id, target)` is a different thing: the hard link a restore takes so retention
  cannot remove its source mid-validation; it takes `exclusive` itself. `list()` and `resolve()` are plain
  directory reads with no lock, so a rotation can remove a listed file before a reader opens it.
- **The store is one synchronous connection.** `server/src/data/resourceStore.ts` opens one `node:sqlite`
  `DatabaseSync` (around 825) in WAL mode (around 3327); every write opens `BEGIN IMMEDIATE` (around 1041), a
  transaction body must be synchronous (around 1842), and `writeCount` counts committed writes since this
  process opened the store (around 966–974), so it starts again at every restart. A restore or an import
  (`replaceAll`) starts a new epoch. No module opens a second connection to the live database; read-only
  connections exist for snapshot and staged files (around 544 and 750). Resource writes check
  `maintenance.assertOpen()` and then write synchronously (`server/src/routes/resources.ts` around 92–95 and
  307–315); they take no asset lock.
- **Reference collection exists for exports, not for retention.** `server/src/data/upstream/assetReferences.ts`
  walks the typed asset fields of characters (image, emotions, additional assets, VITS files, `ccAssets`,
  the GPT-SoVITS reference), the `ui` section's background, personas and their embedded modules, folder
  images, preset images, and modules (`assets`, `icon`); `shared/backups.ts` `selectPartialBackupAssets` and
  the tab's `referencedAssets` (`src/ts/drive/backuplocal.ts`) are narrower copies. None reads inlays, chat
  text, checkpoint pages, or snapshots.
- **Asset keys reach free text.** Chat messages carry `{{inlay::id}}`, whose id names an `inlays` record with
  the `asset` key (typed). The server Lua `getCharacterImageMain` and `getPersonaImageMain`
  (`server/src/lua/bindings.ts` around 1653–1674) answer `{{inlayed::<key>}}` where the id is the character's
  or persona's image key: it names an inlay record with that id (`isImageInlay`), and the media that renders
  is that record's own `asset` (`assets/inlay_<sha256>.<ext>`). `{{asset::name}}`, `{{img::}}`, and the other
  by-name CBS forms resolve through the character's or module's typed list (`src/ts/parser/parser.svelte.ts`),
  so they carry no key. The tab's direct URL is `/api/asset/` plus the hex of the whole key
  (`src/ts/globalApi.svelte.ts` around 175), which never contains `assets/`; `decodeKeyHeader` accepts either
  hex case (`server/src/routes/storage.ts` around 49–68). The service worker answers `/sw/img/<hex>` from
  `risuCache` and, on a miss from an allowed subresource, through `/api/asset/<hex>` (`public/sw.js` around
  244–250), so that spelling names a key too. Besides message rows, a chat's `chats.meta` text holds
  everything of the chat but its messages (`server/src/data/chatStore.ts` around 58–66 and 662): local lore,
  `scriptstate`, the note, `hypaV3Data`, and more. The structured memory tables (`memory_pages`,
  `memory_events`, `memory_threads`, `memory_runs`, and a rebuild's `memory_staged_*` copies, `chatStore.ts`
  around 163–264) hold records as JSON text in `data`; pages, events, and threads also have a scalar `title`,
  while `memory_runs` and `memory_staged_runs` have `result` and `data` and no `title` (around 197 and 258;
  `memoryStore.ts` marks runs `titled: false`). Checkpoint pages hold message `data` verbatim, the captured
  chat fields, and memory chunks (`server/src/data/checkpointStore.ts` header, around 47–55), so whatever a
  message or chat held, a checkpoint holds; a page's text is JSON, and a memory chunk is a JSON array of
  strings, each a row's `data` text, so its records are serialized twice.
- **Prepared exports hold file paths.** `server/src/routes/backupsUpstreamExport.ts` builds a staged export
  whose `assets` list names each referenced asset's file, then waits up to `UPSTREAM_EXPORT_STAGED_TTL_MS`
  (10 minutes, `shared/upstreamExportReport.ts`) for the download, which reads those files. A prepare copies
  the database under `exclusive` and learns its keys only when its worker ends (around 219–275); the worker
  has no deadline of its own, only the request's abort and shutdown. A download takes the export out of the
  waiting list (`take`, around 387) before it streams, and its `finalize` removes the staging folder when the
  stream ends or the client leaves (around 388–420). The version-2 export (`POST /api/backups/export`)
  streams in one request after an `exclusive` database copy, reads its key list (every file on disk, or a
  partial selection) after that copy (`server/src/routes/backups.ts` around 223–275), and holds nothing
  between requests. Realm and upstream imports stage under `.tmp/` and write their assets at commit.
- **Thumbnails are derived.** `server/src/http/assetThumbnails.ts` caches WebP variants under
  `save/cache/thumbnails/<sha256(key)>/`; `removeKey` drops a key's directory and `/api/remove` calls it; a
  sweep after listen drops entries whose source is gone or changed (`server/src/app.ts`, `startBackgroundTasks`).
  The cache has no byte cap (self-host server Issues). The tab's fallback path (`getThumbSrc` without a
  capable worker, `src/ts/globalApi.svelte.ts`) reads the original instead (F13), unchanged by this plan.
- **Checkpoint pages have an unused wrapper.** `store.checkpoints.sweep` (`server/src/data/resourceStore.ts`)
  is called by tests only; the table-wide page sweep runs at open. A deleted chat's pages wait for a restart,
  and until then their text names the chat's assets.
- **The maintenance lock is heavy.** `withMaintenance` (`server/src/data/snapshots.ts`) runs the
  `onMaintenance` listeners first, which abort every generation job, then closes resource and storage
  mutations (503) until the body ends. `exclusive` only serializes with other whole-database operations
  (snapshots, export copies, restores, imports) and closes nothing. The storage routes' `enterMaintenanceGate`
  admits a file write that maintenance then waits for.
- **Client state can name keys.** The draft journal replays a journaled mutation or recovery draft up to
  48 hours after it was made (`src/ts/storage/draftJournal.ts`, `JOURNAL_ENTRY_TTL_MS`). A plugin's
  `saveAsset` returns a key the plugin may keep only in its own storage (`src/ts/plugins/apiV3/v3.svelte.ts`).
- **No disk preflight anywhere.** No server module calls `statfs`; a restore, an import, or the snapshot tick
  on a full disk fails mid-way. `restoreValidated` (`server/src/routes/backups.ts` around 466–478), which the
  snapshot restore, the version-2 import, and the upstream commit (`server/src/routes/backupsUpstream.ts`
  around 455) all call, takes the safety snapshot of the live database before anything else, then links each
  staged asset in and installs (`replaceAll`, whose rows grow the live database). Before it, the restore links
  the snapshot under `.tmp/` (`pin`, a full copy where the link is refused, `snapshots.ts` around 133) and
  writes a normalized staged copy; the version-2 import saves the archive (around 403), extracts its database
  (around 408), writes the normalized staged copy (around 410), and copies each new asset to a staged file
  that is linked in and removed; the upstream commit's database and assets were staged under `.tmp/` by its
  prepare and are linked in.
- **Server-read settings.** A setting the server reads lives in the `providers` section and is read through
  `readProviders()` in `server/src/app.ts` (`requestHistoryLimit` is the pattern); device-local preferences
  live in `localStorage`. Job receipts live in `save/data/generation-jobs.sqlite`, a file of their own in no
  snapshot or archive.

## Decisions

- **D1. References are discovered by scanning, not by an index maintained on write.** A mark run reads every
  table and column of the live store that can hold a key: `resources.data`; `messages.data` (a reroll
  candidate's text included); `chats.meta`; `checkpointPages.text` of the pages a `checkpointPageRefs` row
  names, and `chatCheckpoints.name` and `preview` (`fields` holds only page hashes); `title` and `data` of
  `memory_pages`, `memory_events`, `memory_threads`, `memory_staged_pages`, `memory_staged_events`, and
  `memory_staged_threads`; and `data` of `memory_runs` and `memory_staged_runs`, which have `result` and
  `data` and no `title` (`server/src/data/chatStore.ts` around 197 and 258; `memoryStore.ts` creates no table
  of its own). Slice 1 checks this list against the schema `openChatSchema` creates (`chatStore.ts` around
  162–284); a read that throws on a present table, a missing column included, is a D5 reason, never a skipped
  table. Left out because they hold ids, outcome codes, or a projection: `messages.generationHistory`,
  `chatGroups.result`, `chatSummaries.text` (a projection of `chats.meta`), `memory_threads.state` and the run
  tables' `result` (status values), `memory_rebuilds.plan`, and `chatOrders.ids`. Each read is prefiltered in
  SQL with `instr(col, 'assets/') > 0 OR instr(col, '/api/asset/') > 0 OR instr(col, '/sw/img/') > 0` (D14's
  id pass adds `instr(col, '{{inlay') > 0`). The prefilter is a superset of what the recognizer accepts: every
  column holds `JSON.stringify` output (Current state), which escapes only `"`, `\`, control characters, and
  lone surrogates, and none of `assets/`, `/api/asset/`, `/sw/img/`, and `{{inlay` holds one, so a decoded
  string that contains one of them holds it verbatim in the raw text; the hex after a path is the recognizer's
  concern, not the prefilter's. One reference recognizer (D2) serves the mark, D6's re-mark, and D13's final
  check, and it runs on **decoded** values: a JSON column (`resources.data`, `messages.data`, `chats.meta`,
  `chatCheckpoints.preview`, the memory tables' `data`, and checkpoint page text) is parsed and every string
  value at any depth is scanned, and the strings of a checkpoint memory chunk (a page a checkpoint's memory
  manifest lists), each a row's `data` text serialized once more, are parsed again; a scalar text column
  (`chatCheckpoints.name`, the memory tables' `title`) is scanned as it is. A stored JSON text that does not
  parse is a D5 reason naming its row. The scan runs on a second, read-only `node:sqlite` connection to the
  same WAL database, closed at dispose, in synchronous chunks of rows that yield to the event loop between
  chunks, and it never holds a transaction across an await, on either connection: the store's one connection
  opens `BEGIN IMMEDIATE` for every write (`resourceStore.ts` around 1041) and refuses an asynchronous
  transaction body (around 1842). Each chunk reads what was committed when it ran, so a run records
  `store.writeCount()` as it starts, and the sweep re-marks in D13's synchronous turn when the count differs
  from that one (D6). Snapshots are read the same way (a table an older snapshot lacks is skipped, not a
  failure). A snapshot is immutable, so its reference set (D2's tails and D14's inlay ids) is computed once,
  at the first run that sees it, and stored by snapshot id; the live store is scanned on every run. Checkpoint
  pages no live checkpoint names are not roots, and the daily tick (D4) calls `store.checkpoints.sweep` before
  its scan, so a deleted chat's pages also stop taking space without a restart. Rejected: a reference index
  updated by every write path (chat writes, resource patches, checkpoint captures, Lua inlays, imports,
  restores). A writer the index misses deletes data silently, which is the opposite of fail-closed, and the
  index would have to be rebuilt after every restore anyway. Rejected: the first draft's list of named tables
  (every `resources`, `messages`, and `checkpointPages` row and the memory page tables), which left out
  `chats.meta` and most memory tables, so a key pasted into a chat's local lore or kept in a chat variable was
  unreferenced (audit AL4). Rejected: one read transaction over the whole scan on the store's connection (held
  across awaits it collides with every write's `BEGIN IMMEDIATE`; run in one synchronous turn it blocks the
  event loop for the scan's length; audit AL5). Rejected: the first revision's string-level scan of the raw
  column text with no JSON parse (challenge F1: `encodeFileName` accepts a key with a quote, a backslash, or a
  control character, and `JSON.stringify` escapes it, `resourceStore.ts` around 3258, so the raw tail differs
  from the key, the key is unmarked, and a snapshot's stored set keeps the miss for good). Rejected: `title`
  for every memory table (the first revision; challenge F6: the run tables have none, so the read throws
  `no such column` and every run is incomplete). The scan's cost on a large store, the parse included, is
  measured in Slice 1 and recorded in `docs/audit/asset-scan-<date>.md`; the prefilter keeps it to the rows
  that can hold a key.
- **D2. What counts as a reference in text (RisuNest open item 4).** The recognizer is string-level and
  over-approximating, and it reads decoded strings (D1), never serialized text. After each occurrence of
  `assets/` in a string, it takes the bounded tail that follows (at most `MAX_FILE_NAME_BYTES`, 255 UTF-8
  bytes, of decoded text, `server/src/routes/storage.ts` around 82–118: no logical name the codec stores is
  longer, since both file-name forms are at least as long as the name's bytes) and records it; every prefix of
  that tail the codec accepts (`encodeFileName` gives a name that `decodeFileName` turns back) is a possible
  key. Each `/api/asset/<hex>` and `/sw/img/<hex>` (the service worker's spelling, which it answers through
  the signed route, `public/sw.js` around 244–250) has its run of hex digits, either case, decoded as
  `decodeKeyHeader` does (`storage.ts` around 49–68; the longest even-length run, cut at its first byte that
  is not valid UTF-8 and bounded like a tail), and the decoded text is recorded as a tail the same way, so a
  hex run followed by more hex digits still yields its key by prefix. A snapshot's stored reference set is its
  set of tails, independent of what is on disk, and each run intersects the tails of every root with the keys
  on disk by prefix: a disk key is referenced when some tail starts with its name. So a key that a snapshot
  named while the file was missing, and that was republished after the snapshot was indexed, is still found.
  This subsumes the typed walk (the same strings), catches the image key inside `{{inlayed::…}}`, HTML written
  by regex scripts or `backgroundHTML`, a reroll candidate's text, and lorebook, chat-lore, variable, or module
  text that pasted a key. By-name CBS forms need no handling: they resolve through typed lists that are
  themselves scanned. The inlay forms `{{inlay::id}}`, `{{inlayed::id}}`, and `{{inlayeddata::id}}` name
  records, not files: the recognizer records the id up to the next `}}`, as the tab's parser reads it
  (`src/ts/parser/parser.svelte.ts` around 848), for D9's attribution and D14. The typed walk
  (`collectAssetReferences`, extended with owner ids) is still run, for attribution only (D9). Rejected: a
  typed walk alone (misses the Lua key form and any text a plugin or script wrote), a CBS-aware parse of
  message text (slower, and a key outside CBS syntax would be missed), and a token parser that takes the
  longest codec-valid run after `assets/` (the first draft's "a character run the file-name codec accepts"):
  the codec escapes nearly any byte, so a greedy run takes in the closing quote, `}}`, or the following text
  and names a key that does not exist, leaving the real one unmarked (audit AL3). Prefix matching
  over-matches instead: text naming `assets/a.png` also keeps a disk key `assets/a.p`, which keeps data, the
  safe direction. Rejected: storing the matched disk keys per snapshot (a key missing at indexing time and
  republished later would never match the immutable snapshot again). Rejected: recognizing only
  `/api/asset/` with lowercase hex (the first revision; challenge F1: the service worker fetches
  `/sw/img/<hex>` through the signed route on a cache miss, and `decodeKeyHeader` decodes uppercase hex, so
  either spelling in live text names a key).
- **D3. Roots.** An asset is referenced when any of these names it: the live store (D1's columns, all kinds,
  including `inlays` records, whose `asset` stays alive as any resource's key does; D14 reports the records
  no text names); every listed snapshot in `save/backups/`, pinned or not, safety snapshots included; every
  export for its whole operation (D7's operation lifetimes: an upstream export from its prepare's database
  copy through its waiting time to the end of its download stream, its cancel, or its TTL, and a version-2
  export from its `exclusive` copy to the end of its stream; both register in the one `heldAssetKeys()` that
  `backupsUpstreamExport.ts` exposes); the recent-use lease (D7); and youth: a file whose mtime is within the
  grace period. The mark takes the restore's hard link of each snapshot (`pin`, renamed `stageCopy` by D8)
  under `save/.tmp/` before indexing it and removes the link after, so a rotation tick cannot remove the file
  mid-read; a snapshot rotated away before the link is taken is no longer a root and does not make the run
  incomplete, while one that exists but cannot be opened does (D5). The link is taken outside `exclusive`,
  since `pin` takes that lock itself. Non-roots: the thumbnail cache (derived; `thumbnails.removeKey` runs
  with the delete), Realm and upstream import staging (under `.tmp/`, not `assets/`; the commit's writes are
  young files or go through D7's contract), the browser's caches and client state (D11), and generation jobs
  (an inlay a job writes is a young file and then an `inlays` record). Restore and import need no special
  root: they install under `withMaintenance`, which holds `exclusive` as the sweep's batches do, and they
  start a new epoch, so D6 accepts no run made before them; a restored snapshot is a listed root. Rejected:
  the first revision's accepted limitation that youth and the grace period cover a prepare whose worker has
  not ended, a download in flight (which has left the waiting list), and the version-2 export's stream
  (challenge F4: a key a live record named minutes earlier need not be a young file, and its ledger `since`
  changes only at a complete scan, so a scan during the stream could find it unreferenced and long past the
  grace).
- **D4. The grace period and the unreferenced ledger.** A new database `save/data/asset-lifecycle.sqlite`
  (beside `save/data/generation-jobs.sqlite`, outside snapshots, so a restore never rolls the ledger back)
  holds `snapshotRefs(snapshotId, tail)` and `snapshotInlays(snapshotId, id)`, `unreferenced(key, since,
bytes)`, `orphanInlays(id, since)` (D14), and `runs(startedAt, complete, reasons, counts)` for the report.
  A complete run inserts a key found unreferenced with `since = now` if absent, deletes a key found
  referenced, and leaves the rest. A key is deletable when `since + grace <= now`, the file's mtime is older
  than `grace`, and the recheck (D6) agrees. `grace` defaults to 7 days (`RISU_ASSET_GRACE_DAYS`), with a
  minimum of 3 days: the draft journal replays rows up to 48 hours old (`src/ts/storage/draftJournal.ts`,
  `JOURNAL_ENTRY_TTL_MS`), and a journaled write may name an asset it uploaded. A read-only scan runs daily
  (one hour after `startBackgroundTasks`, then every 24 hours, skipped while a restore or import holds the
  lock; each tick first calls `store.checkpoints.sweep`, D1), so the clocks tick without anyone opening the
  page; the user can start one from the report. The lifecycle module reads time through one wall clock and
  one monotonic clock. A development-only offset, `RISU_AGENT_DEV_ASSET_CLOCK_OFFSET_MS`, is added to both,
  so it moves the grace, the lease, and D6's uptime gate alike; the server has no production-build flag, so
  "development only" is the gate `RISU_AGENT_DEV_AUTH_BYPASS` already has (`server/src/listenConfig.ts`: refused
  unless `RISU_HOST` is a numeric loopback address), and the server logs the offset at start. The browser
  check uses it instead of a grace of 0. Rejected: a tombstone per deleted key (nothing consults it after the
  file is gone; D11 explains the browser side), keeping the ledger in `resources.sqlite` (a restore would
  resurrect old `since` stamps), and a minimum of 1 day (below the journal's 48 hours; audit AL raw §10).
- **D5. Fail-closed.** A run's result is `complete: false` with reasons when any root could not be read in
  full: a listed snapshot that exists but cannot be opened or walked (the report names it, so the user can
  delete it with Slice 3's Delete), a store table read that throws (a missing column of a present table
  included) or a stored JSON text that does not parse (D1), an export whose key set the mark waited for past
  the bound (D7), the assets directory not listable. A snapshot rotated away before the mark linked it is not
  a reason (D3). An incomplete run still updates the report's sizes and shares but writes nothing to
  `unreferenced` or `orphanInlays` and makes `POST /api/assets/sweep` a 409 `Reference set incomplete`. A file
  whose name the codec cannot round-trip (`decodeFileName` returns null) is listed as "unmanaged bytes" and is
  never a candidate. A key whose owner the typed walk does not know is still a reference (D2); unknown owners
  only affect attribution. Rejected: the first draft's "export staging not answering" reason (the staging is
  synchronous and in memory; it always answers).
- **D6. Sweep mechanics.** The report is the dry run: it lists the candidates (deletable keys, bytes, how long
  unreferenced) and the orphan inlay records (D14). `POST /api/assets/sweep`
  `{ dryRun: boolean, keys?: string[], inlays?: string[] }` (`dryRun: true` answers what would be deleted
  without touching anything; `keys` narrows a run to a selection; `inlays` names orphan records to remove)
  requires the latest run to be complete, made by this process on the current epoch, and no older than one
  hour, else 409. The run's identity is in memory (a counter of this process's runs and `store.epoch()`),
  never a persisted `writeCount`, which starts again in every process (`resourceStore.ts` around 966–974). The
  sweep is also a 409 until the process has been up for `ASSET_LEASE_MS` of monotonic time, so every lease
  promised before a restart has expired (D7). Deletion goes in batches of 50 keys, each batch a turn of
  `snapshots.exclusive` (it never overlaps a restore's or an import's install or a rotation): the snapshots
  are listed again and any taken after the mark is indexed from its file (rotation and removal run under the
  same lock, so no link is needed, and `stageCopy` must not be called while holding it); the batch waits for
  any export that has copied the database and not yet produced its key set (D7); the batch's key locks (D7)
  are taken; then D13's synchronous turn re-marks the live store when `store.writeCount()` differs from the
  count the mark recorded as it started, a baseline no narrowed re-mark moves (D13), and per key checks that
  it is still in the candidate set, not leased, and its mtime still older than `grace`, and unlinks it;
  `assetVerification.forgetVerification`, `thumbnails.removeKey`, and the ledger row removal follow after the
  turn, and the key locks are released. The answer is
  `{ deleted, freedBytes, removedInlays, skipped: [{ key, reason }] }`; a filesystem error skips the key with
  its reason and continues (unlike `/api/remove`). Rejected: `withMaintenance` for the sweep (it aborts every
  generation job and answers 503 to every write for the sweep's length; the exclusive batches, D13's
  synchronous turn, and the per-key lock give the needed ordering without that). Rejected: accepting a
  persisted run or a run made right after a restart (the first draft let the user scan and sweep at once after
  a restart, inside the lost leases' hour, and a persisted `writeCount` can equal the new process's count by
  accident; audit AL2). Rejected: batches of 200 (the synchronous turn would last four times as long).
  Rejected: comparing with the count of the last batch's re-mark (the first revision; challenge F2: a re-mark
  narrowed to one batch's keys moved that count for every key, so a reference to a later batch's key written
  before the first batch was never re-marked, and the key was deleted).
- **D7. Concurrency with uploads and reads: one publish contract.** Three rules close the window between
  "unreferenced" and a new reference. Youth: the mtime rule of D3 covers every write that publishes a file.
  The lease: an in-memory, bounded map of key → last use, bumped whenever D7's helper finds or publishes a
  key and when `/api/asset/*` serves it; a key used within `ASSET_LEASE_MS` (one hour) is a root. The
  contract: every path that makes a key referenced goes through one helper in `routes/storage.ts`
  (`claimAssetKey`): the single and batch publish renames (`writeStorageFile`, which the Lua inlay writes
  also call, and `/api/assets/write`'s per-record rename), the content-asset imports' skip when the file
  already holds the bytes and their staged rename (`writeContentAsset` and `publishStagedContentAsset`,
  `server/src/http/contentAsset.ts` around 35–46 and 67–78), the module import's skip
  (`server/src/routes/importModule.ts` around 125–136), and the present answer of `/api/assets/missing`. The
  helper takes the key's lock (a small `assetLocks` map shared with the sweep), verifies presence under it,
  bumps the lease, publishes when the file is missing or does not hold the bytes, and releases; the sweep's
  recheck-to-unlink runs under the same lock, so a claim and a delete of one key never interleave: a claim
  after the delete finds the file gone and publishes, or answers missing so the tab uploads. The backup and
  upstream imports' asset install runs inside `withMaintenance`, which holds `exclusive`, so the sweep's
  batches are already ordered with it. The tab's batch import (`src/ts/storage/assetClient.ts`
  `writeAssets`, around 394–430) asks `/api/assets/missing` per write batch rather than once up front, so a
  present key's lease starts when its own batch is sent. The tab's inlay writer does not take its cache for
  server presence: `storeMedia` (`src/ts/process/files/inlays.ts` around 316–329) skips the upload when its
  `blobCache` holds the key, a shortcut only today's never-delete policy makes safe, so on a cache hit it asks
  `/api/assets/missing` for the key before `writeMedia` (around 331–345) writes a new record (the present
  answer is a claim) and uploads the call's own bytes when the server answers missing. Operation lifetimes,
  since an operation that names keys can outlive one batch's lease: an import re-asks `/api/assets/missing`
  for every key its record names right before the record write, one cheap call per import that claims each
  present key again and repairs a missing one by re-upload. `saveAssets` (`src/ts/storage/assetQueue.ts`
  around 249) keeps each item's `load`, not its bytes, and after its queue drains asks the missing check once
  for every key it returns, re-loads and re-writes each key answered missing, then returns; its callers (the
  card imports in `src/ts/characterCards.ts`, the module import in `src/ts/process/modules.ts`, the model
  import in `src/ts/process/transformers.ts`) write their record right after it, inside the fresh lease, with
  no upload or user prompt between. The server module import (`server/src/routes/importModule.ts` around
  125–146) does the same before it returns the module: each key it filled goes through `claimAssetKey`
  again, with the record re-read from the uploaded file (open until `finalize`) as the bytes to publish when
  the file is gone. An export's keys are a root from its start through the end of its stream: an upstream
  export's from its prepare's database copy, through its waiting time, to its download stream's `finalize`
  (the download no longer drops them from `heldAssetKeys()` when `take` removes the export from the waiting
  list), its cancel, or its TTL; a version-2 export's from its `exclusive` copy to its stream's end. While an
  export has copied the database and not yet produced its key set, the mark waits for it before it reads
  `heldAssetKeys()`, and so does each sweep batch inside its `exclusive` turn (the worker takes no lock, so
  the wait cannot deadlock, and an export whose copy queues behind the batch copies what the batch left). The
  prepare has no deadline of its own (Current state), so the wait is bounded by
  `UPSTREAM_EXPORT_STAGED_TTL_MS`: past it the run is incomplete (D5), or the batch skips every key it holds
  with the reason. The lease is lost at restart; D6's uptime gate covers that. Rejected: making `/api/assets/write`
  refuse during a sweep (it is a 503 the client retries, but a client that got "present" from the missing
  check does not write at all). Rejected: a lock around the two publish renames only, with the lease bumped
  only by the missing check (imports reuse a present file with its old mtime, no lease, and no lock, so a
  re-import during a sweep loses the image the new record names; audit AL1), and a lease bumped after an
  unlocked presence check (the check and the delete can interleave). Rejected: "the lease is lost at restart,
  which is acceptable: the first scheduled scan is an hour after start" (a user-started scan right after a
  restart is complete; audit AL2). Rejected: the first revision's accepted limitation that an import whose
  remaining uploads outlast `ASSET_LEASE_MS` after a present key's batch can lose that key (challenge F4:
  nothing at the record write checked the key again, and the server module import had the same gap between
  its early skip and the module it returns). Rejected: a `blobCache` hit as server presence in the inlay
  writer (challenge F3: after the sweep deleted the media, a new inlay record named the gone file with no
  upload, missing check, or claim, and another tab or a reload could not render it).
- **D8. Pinned and labeled snapshots.** `snapshots.ts` gains `setPinned(id, pinned, label?)` and `remove(id)`;
  retention counts unpinned snapshots only (`keep` of them), a pinned snapshot is never rotated, and
  `remove` refuses a pinned id (409) until it is unpinned. Pins and labels live in `save/backups/pins.json`
  (durable write; an entry whose file is gone is dropped at list time), not in the snapshot file, and are not
  carried by a restore. `BackupSnapshotInfo` gains `pinned`, `label`, and `heldBytes` (D9). `snapshotNow`
  takes `{ label? }` for the manual snapshot. At most 20 pinned snapshots (409 beyond; Q3), so at most 40
  database copies, each also carrying the Incremental Chat Transport plan's `changes` log (up to about 4 MB,
  160 MB over the 40). The existing `pin(id, target)` (the restore's and D3's mark's hard link) is renamed
  `stageCopy` to free the word (V4). A pinned snapshot is a root like any other (D3): pinning extends an
  asset's life for as long as the pin exists, which is RisuNest item 8's semantics and the answer to open
  item 4's "pinned-snapshot" half. Rejected: a daily tier (keep one per day for D days); pins cover the need
  the owner named and a tier is in **Later**.
- **D9. The report and where it shows.** `GET /api/assets/report` answers the latest run (no-store):
  `generatedAt`, `complete` and `reasons`, `running`, `disk: { free, total }`, `usage: { assetsOnDisk,
resourcesDb, snapshots, thumbnails, staging, unmanaged }`, `referenced: { logicalBytes, dedupedBytes,
savings, count }`, `unreferenced: { count, bytes, pastGrace: { count, bytes }, candidates: [{ key, bytes,
since }] }` (the candidate list capped at 2,000 entries with a total), `orphanInlays: { count, bytes,
records: [{ id, asset, bytes, since }] }` (D14, capped the same way), `owners: [{ kind: "character" |
"module" | "persona" | "preset" | "folder" | "settings" | "inlays", id, name, bytes, count }]`, and
  `snapshots: [{ id, createdAt, size, pinned, label, heldBytes }]`. Logical bytes sum each reference's file
  size (a profile image three characters share counts three times); deduplicated bytes sum unique files;
  the owner shares are logical and may sum past the deduplicated total, which the UI says. Inlays are found
  through the ids D2 records after `{{inlay::`, `{{inlayed::`, and `{{inlayeddata::`, not through `assets/`,
  and attributed to the character whose chat names the id (`messages.chatSeq → chats.characterId`), and to
  `inlays` when no chat does. `heldBytes` of a snapshot is the size of the keys only that snapshot
  references (no other root). `POST /api/assets/scan` starts a run (409 while one runs); the UI polls
  `report` while `running`. The UI is a new "Storage" section of Advanced settings
  (`advancedSettingsSections` in `src/ts/setting/advancedSettingsData.ts`, a `custom` item rendered by a new
  `src/lib/Setting/Pages/Advanced/StoragePanel.svelte` registered in `src/ts/setting/customComponents.ts`,
  the `DiagnosticsPanel` pattern): the totals, the owner table, the candidate list with a Delete button that
  confirms with the count and bytes, the orphan inlay records with their own Delete, and the snapshot list
  with Take, Pin, Label, Restore, and Delete. `loadInternalBackup` on the User page stays as it is. Rejected:
  a settings page of its own (the registry's sectioned pages already give search and jumps; a new page needs
  a menu index and routes).
- **D10. Manual deletion in this plan; automatic deletion opt-in later (Q2, answered: later).** The slices ship the scan
  (automatic, read-only) and the sweep (user-started). An automatic sweep, if the owner wants it, is one
  `providers` field `assetAutoSweep` (default off) that makes the daily scan's complete run end with a sweep
  under D6's rules; Q2 kept it in **Later**, so no slice ships it. Rejected: automatic
  deletion on by default (the adopted policy says opt-in).
- **D11. Deleted hashes and the browser's immutable cache.** A sweep deletes only keys no root named for at
  least the grace period, so no live record renders them; a tab that still shows one holds a page it has not
  reloaded for that long, and the browser cache keeps showing the cached bytes until eviction, then the
  element gets a 404, as a missing file does today (global API, Asset sources). The service worker's
  fallback cache (`risuCache`) is unaffected. Re-uploading the same bytes recreates the same key, so a cached
  URL never shows wrong content. No server-side tombstone or 410 list (D4). Keys held only in browser state
  are not roots either: a draft journal entry replays for up to 48 hours, which D4's 3-day floor covers, and
  a key a plugin keeps only in browser-only state is covered by nothing (the plugin storage API itself is
  server-backed, a `resources` record D1 scans). The guide records both under
  Limitations with a decision pointer.
- **D12. Disk preflight.** A helper `freeBytes(path)` over `fs.statfs` (Node 24) backs the report's `disk`
  and a preflight in the heavy operations. Each preflight sits at a checkpoint and sums the allocations still
  to come from there, files already on disk excluded (Current state lists the steps):
  `POST /api/backups/:id/restore` before `stageCopy` (the normalized staged copy, about the snapshot's size;
  the live database's safety snapshot, which `restoreValidated` takes first; and the install's growth, about
  the snapshot's size again), plus the snapshot's size when `stageCopy`'s hard link is refused and it falls
  back to a copy (`server/src/data/snapshots.ts` around 133), checked again there before the copy;
  `POST /api/backups/import` in two steps, since it saves the uploaded archive before it can read sizes
  (`server/src/routes/backups.ts` around 396–405): before saving, the upload's `Content-Length` (a request
  without one skips this step), then, once the archive is parsed and before its database is extracted (around
  408), the extracted source database plus the normalized staged copy plus the live database's safety
  snapshot plus the install's growth plus its assets not yet on disk, the saved archive excluded; the upstream
  commit (the live database's safety snapshot, which `restoreValidated` takes first,
  `server/src/routes/backupsUpstream.ts` around 455, plus the install's growth, about the staged database's
  size; its staged database and assets are already under `.tmp/` and are linked in); the upstream export
  prepare (the database copy plus the encoded save); and the snapshot tick (the database's size; a short tick
  logs once and skips, it never throws). The threshold is the estimate plus 5 percent and a floor of 64 MiB;
  the margin is slack for estimation error (WAL growth, file-system overhead), never a substitute for a
  mandatory copy, so every copy an operation must write is in its estimate. A short answer is 507
  `Insufficient Storage` with `{ needed, free }` before that step writes anything. A `statfs` failure
  (unsupported filesystem) disables the preflight for that operation with one log line: it is a guard for a
  user-started operation, not a deletion, so it fails open. Rejected: a byte budget that deletes to make room
  (F08's budget idea; not a goal), and the first draft's estimates (twice the snapshot for a restore, which
  leaves out the live database's safety snapshot, and one check before an import's staging, which cannot know
  the database's size before the archive is saved; audit AL raw §14). Rejected: the first revision's
  estimates for the upstream commit (the archive's database plus its assets not yet on disk, which left out
  the safety snapshot of a live database that can be far larger than the imported one) and for the version-2
  import's second check (its database staged and installed, placed before the install: that left out the
  extracted source database and came too late to guard extraction and staging; challenge F5).
- **D13. The sweep's last check and its unlink run in one synchronous turn.** Store writes take no asset
  lock: a chat write that names `assets/K` commits synchronously whenever the event loop reaches it, so a
  write that lands after a batch's recheck and before its `unlink` names a deleted file, with no upload,
  missing check, or read involved (the cross-audit's finding). The store is synchronous (one `DatabaseSync`),
  so no write can interleave with a synchronous turn. Each sweep batch (D6), inside its `snapshots.exclusive`
  turn, holding its keys' locks, and after indexing any snapshot taken since the mark, runs one synchronous
  turn on the store's own connection: if `store.writeCount()` differs from the count the mark recorded as it
  started, it re-marks the live store synchronously with D2's recognizer, narrowed to the batch's keys when
  that is cheaper than the full scan. A narrowed re-mark certifies only the keys it read and never moves the
  run's baseline; only a full live re-mark may reset it, to the count that re-mark ran at, so a later batch
  compares with the mark's count again and re-marks too. The narrowed re-mark reads D1's columns through a
  per-key prefilter that is a superset of the recognizer's input: `instr(col, '<p>') > 0`, where `<p>` is
  `assets/<name>` cut before its first character `JSON.stringify` escapes, or
  `instr(lower(col), '/api/asset/<hex>') > 0` or `instr(lower(col), '/sw/img/<hex>') > 0` with the key's
  lowercase hex; each passes every longer tail or hex run D2's prefix rule matches, and the recognizer then
  decides on the decoded values as in the mark (D14's ids the same way, cut the same way). The export staging
  and the lease are in memory; then for each key it reads the mtime with `statSync`, checks the lease and the
  candidate set, and calls `unlinkSync`, and D14's orphan records still orphaned are removed by a synchronous
  store write in the same turn. `thumbnails.removeKey`, `assetVerification.forgetVerification`, and the ledger
  row removal follow asynchronously after the turn; they concern a file that is already gone. The turn's bound
  is one batch's synchronous filesystem work (at most 50 `statSync` and `unlinkSync` calls) plus the narrowed
  re-mark, measured with the scan in the audit note Slice 1 starts; reads wait for that turn too, and writes
  queue behind it and land after it, never fail. A write that commits after the turn and names a key it
  deleted is ordered after the delete of a key no root named for the grace period, the same as a write naming
  any missing file; a write naming a key of a later batch moves `writeCount` away from the mark's count,
  whether it landed before the first batch or between two, so that batch re-marks and sees it. Rejected: a
  recheck per key with no ordering point (the gap stays between the last check and `unlink`),
  `withMaintenance` (D6), and a write hold, `store.withWritesHeld(fn)` with a `store.writable()` that writers
  await (every asynchronous writer would have to await admission before its synchronous write: about 80 call
  sites in some 15 files across the routes, the generation job, the translation runner, checkpoint captures,
  and the memory writers, and a writer that skipped it would be a silent hole). Rejected: the first revision's
  literal final check on the raw text, `instr(col, 'assets/<name>') > 0 OR instr(col, '/api/asset/<hex>') > 0`
  (challenge F1: an escaped key's raw text is not `assets/<name>`, uppercase hex decodes through
  `decodeKeyHeader`, `storage.ts` around 49–68, and `/sw/img/` was absent, so the final check could pass a key
  the mark keeps), and a baseline taken from the last batch's re-mark (challenge F2; D6).
- **D14. Orphan inlay records.** An `inlays` record keeps its `asset` alive as any resource does (D3), but
  nothing removes records when the text that named them goes: a character delete removes its chats and no
  `inlays` record, and only the Playground inlay explorer calls `removeInlayAsset`. So the run also lists
  "orphan inlay records": records whose id no root's text names through `{{inlay::id}}`, `{{inlayed::id}}`,
  or `{{inlayeddata::id}}` (D2's id pass), with a `since` in the ledger like an unreferenced key, and past the
  grace period. Deleting them is a user-started action in the Storage panel (Slice 4): the sweep's `inlays`
  list removes each record that is still orphaned past the grace, in D13's synchronous turn after the
  re-mark; the record's asset then follows the ordinary grace path (unreferenced at the next run, deletable a grace
  period later). Rejected: inlay records as unconditional roots with nothing reported (the first draft;
  generated images, the main growth source, were never reclaimable, and the browser check's "two keys
  unreferenced" could not pass), and removing orphan records automatically (a record nothing names may be a
  library item the Playground manages).

## Open questions

All three were answered on 2026-11-03 with the recommended option; they are kept here as the record of why.

- **Q1. The grace period.** Recommended: 7 days, PocketRisu's value, as the default of `RISU_ASSET_GRACE_DAYS`
  (minimum 1). A shorter default saves little (the clocks only start at the first complete scan) and shrinks
  the window in which a restore of a deleted chat still finds its inlays. The alternative, no grace with the
  recheck alone, is rejected by the adopted policy. The minimum of 1 day is superseded (2026-11-04, D4): the
  minimum is 3 days, above the draft journal's 48-hour replay; the default stays 7.
- **Q2. Automatic deletion in scope.** Recommended: not in this plan's slices; the daily scan is automatic and
  read-only, deletion is the user's click on a report they have seen. If the owner wants the opt-in sweep now,
  it is the `assetAutoSweep` field of D10 in Slice 2, default off, with the same fail-closed rules, and the
  report shows the last automatic sweep's result.
- **Q3. Pinned snapshots and the count of 20.** Recommended: pinned snapshots do not count toward the 20
  rotated ones and are capped at 20 themselves, so the worst case is 40 database copies, each at most the
  database's size. The alternative, pins inside the 20, means a user who pins 20 snapshots stops the periodic
  snapshot silently.

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Slices 1, 2,
and 3 all edit `server/src/routes/backups.ts`, and 2 and 3 also `server/src/data/snapshots.ts`: one at a
time.

### Slice 1: the mark, the ledger, the report (D1–D5, D9's route, D12's helper, D14's report; needs nothing)

Files: new `server/src/data/assetLifecycle.ts` (the lifecycle database, the read-only connection and its
chunked scan, the one recognizer over decoded values (the tails, both hex forms, and the inlay ids, shared
with Slice 2's re-mark), the per-snapshot index read through `pin`'s link, the typed
attribution walk over `collectAssetReferences` extended with owner ids, the run record and the in-memory run
identity, the orphan inlay records, the clocks with the development offset, the daily scan that calls
`store.checkpoints.sweep` first), new `shared/assetLifecycle.ts` (the report shape, the route paths,
`ASSET_LEASE_MS`, the grace default and minimum), new `server/src/routes/assetLifecycle.ts`
(`GET /api/assets/report`, `POST /api/assets/scan`, `checkAuth`, no-store, the storage limiter), new
`server/src/http/diskSpace.ts` (`freeBytes`), `server/src/routes/backupsUpstreamExport.ts` (`heldAssetKeys()`
over waiting exports, prepares from their database copy, and downloads until `finalize`; the wait for a
prepare's key set), `server/src/routes/backups.ts` (`listAssetKeys` gains sizes and the unmanaged list, or a
sibling `listAssetFiles`; the version-2 export holds its keys in `heldAssetKeys()` from its copy to its
stream's end), `server/src/data/snapshots.ts` (nothing new: `list`, `resolve`, and `pin` are what the index
uses), `server/src/listenConfig.ts` (`RISU_AGENT_DEV_ASSET_CLOCK_OFFSET_MS` under the loopback gate),
`server/src/app.ts` (wiring, the daily scan beside the thumbnail sweep, `dispose` waits for a running scan and
closes its connection), the self-host server guide (Storage routes, Disk layout: `data/asset-lifecycle.sqlite`,
Process memory, Flows: the mark), the server resources guide (State: the snapshot reference index; the Issues
entry about retained snapshots becomes a Limitation naming D3, which Slice 2 rewrites), the found-issues entry
"checkpoints.sweep has no product caller" (closed by the daily tick), `docs/audit/asset-scan-<date>.md` (the
scan's cost on a seeded store).

- Tests (new `server/src/tests/assetLifecycle.test.ts` with a seeded store, real snapshot files, and an
  injected clock; `server/src/tests/backups.test.ts`; `server/src/tests/upstreamExportRoute.test.ts`;
  `server/src/tests/app.test.ts`; `server/src/tests/listenConfig.test.ts`): a key named only by a typed field,
  only by `{{inlayed::assets/…}}` in a message, only inside a non-selected candidate's text in a message row,
  only by a chat's `localLore`, only by a chat's `scriptstate`, only by a `memory_events` row, only by a
  `memory_staged_runs` row, only by a `/api/asset/<hex>` URL, only by a `/sw/img/<hex>` URL, only by an
  `/api/asset/` URL in uppercase hex, only by a checkpoint page, only by a checkpoint memory chunk (the second
  serialization layer), only by a snapshot, only by a prepared export, only by an upstream export whose
  download is streaming (after `take`, until its `finalize`), only by a version-2 export while it streams,
  and only by a young file is referenced, and a key named by none is unreferenced with `since` set once; a
  key with a quote, one with a backslash, and one with a newline, each named only by a typed field and so
  stored escaped, are referenced, live and in a snapshot's stored set; a mark started while a prepare's worker
  runs (a latch) waits for its key set and marks its keys, and a prepare still running past the bound makes
  the run incomplete; both run tables are read with `data` alone, and a read that throws on a present table (a
  test schema without a scanned column) or a stored JSON text that does not parse makes the run incomplete
  with the reason; a referenced key leaves the ledger; a tail
  `assets/a.png"}}` marks the disk keys `assets/a.png` and `assets/a.p` and no key that is not on disk; a
  snapshot indexed while its key was missing marks that key once it is republished; a snapshot is scanned
  once and its set reused while a new snapshot is scanned on the next run; a checkpoint page no checkpoint
  names is not a root, and the daily tick calls `store.checkpoints.sweep`; a snapshot rotated away between the
  mark's `list()` and its link is not a reason, while a snapshot that cannot be opened makes the run
  incomplete with the reason naming it, writes nothing to the ledger, and still reports sizes; a store write
  issued between two chunks of the scan commits (a latch between chunks) and the run's starting `writeCount`
  is below it; an unmanaged file name is counted and never a candidate; logical, deduplicated, and owner bytes
  for a shared profile image; inlay attribution to the chat's character through the id; an inlay record no
  text names is listed as orphaned with its `since`, and one a message names is not; `heldBytes` of a snapshot
  that alone names a key; the routes need auth, answer no-store, and `scan` is a 409 while a run is on; the
  daily tick skips under maintenance; `freeBytes` with an injected `statfs`; the clock offset is refused
  without a loopback `RISU_HOST` and moves the grace and the lease clocks when allowed.

### Slice 2: deletion, the publish contract, the synchronous delete turn, the disk preflight (D6, D7, D12, D13, D14's removal; needs 1)

Files: `server/src/data/assetLifecycle.ts` (the sweep: batches of 50 under `snapshots.exclusive`, the run
identity and uptime checks, the snapshot re-listing, the wait for an export's key set, the synchronous turn
with the narrowed re-mark whenever `writeCount` differs from the mark's, `statSync`, and `unlinkSync`, the
asynchronous cleanup after it, the orphan inlay removal), `server/src/routes/assetLifecycle.ts`
(`POST /api/assets/sweep`), `server/src/data/resourceStore.ts` (a synchronous read of D1's columns on the
store's connection, narrowed by a per-key prefilter), `server/src/routes/storage.ts` (`claimAssetKey`, the
`assetLocks` map, the lease bumps in `/api/assets/missing` and `/api/asset/*`, both publish renames),
`server/src/http/contentAsset.ts` (`writeContentAsset`'s skip and `publishStagedContentAsset`'s skip and
rename through `claimAssetKey`), `server/src/routes/importModule.ts` (the module import's skip through
`claimAssetKey`, and every filled key claimed again before the result line, re-read from the uploaded file
when gone), new `server/src/http/assetLeases.ts` (the bounded lease map, if `storage.ts` would grow past its
budget), `src/ts/storage/assetClient.ts` (`writeAssets` asks the missing check per write batch),
`src/ts/storage/assetQueue.ts` (`saveAssets` keeps each item's `load` and ends with one missing check over
every key it returns, re-writing a key answered missing; its callers in `src/ts/characterCards.ts`,
`src/ts/process/modules.ts`, and `src/ts/process/transformers.ts` are checked for an upload or a prompt
between it and the record write, and such a step moves before it), `server/src/routes/backups.ts`,
`server/src/routes/backupsUpstream.ts`, `server/src/routes/backupsUpstreamExport.ts`,
`server/src/data/snapshots.ts` (the preflights of D12, and `pin`'s check before its fallback copy),
`src/ts/process/files/inlays.ts` (a behavior change: `storeMedia` asks the missing check on a `blobCache` hit
too and uploads the bytes when the server answers missing, before `writeMedia` writes a new record; the header
and `removeInlayAsset`'s comment: blobs are deleted by the server's sweep once unreferenced past the grace
period, never here), the self-host server guide (Storage routes, Flows: the sweep, the lease, and the
synchronous delete turn, Invariants: every publish and every reuse of a key goes through `claimAssetKey`,
Known Hazards: the D11 Limitation; the thumbnail cache's "no byte cap" Issue stays), the server resources
guide (the Limitation Slice 1 wrote about retained snapshots rewritten: they hold their assets until rotated
or deleted, and the sweep reclaims them after; Maintenance: the sweep's batches use `exclusive` and one
synchronous turn, not maintenance; the restore's and imports' preflight), `docs/audit/asset-scan-<date>.md`
(the synchronous turn's cost on the seeded store), the global API guide (Asset client: a present answer from
the missing check is a one-hour lease, asked per batch and again for every key at an import's end; the inlay
writer's cache hit is no proof of presence). Not in parallel with Incremental Chat Transport Slices 1 and 3
(`server/src/data/resourceStore.ts`).

- Tests (`server/src/tests/assetLifecycle.test.ts`, `assets.test.ts`, `assetRoute.test.ts`, `backups.test.ts`,
  `snapshots.test.ts`, `importModule.test.ts`, `resourceStore.test.ts`, `upstreamExportRoute.test.ts`,
  `upstreamImportRoute.test.ts`, `src/ts/storage/tests/assetClient.test.ts`,
  `src/ts/storage/tests/assetQueue.test.ts`, `src/ts/process/files/tests/inlays.test.ts`, with injected clocks
  and `statfs`): a candidate past both clocks
  is deleted with its thumbnail directory and verification entry, and the ledger row goes; a candidate whose
  file was republished (young mtime) is skipped with the reason; a key the missing check answered present
  within the hour is skipped; a key referenced by a write that landed after the mark is skipped because the
  re-mark sees it; a snapshot taken after the mark that names a candidate is indexed inside the batch and the
  key is skipped; a chat write naming a candidate of a later batch, queued behind a batch's synchronous turn
  (latch), lands after it and is not refused, and that key is not deleted by the next batch because the
  re-mark sees it; with 51 candidates, a chat write naming the 51st committed after the mark and before the
  first batch keeps that key although batch 1's narrowed re-mark read only its own 50 (the baseline stays the
  mark's count), and after a full re-mark a batch with no write since skips its re-mark; a write that
  committed before the turn makes the re-mark keep the key; the narrowed re-mark keeps a key named only by a
  longer tail, only by a `/api/asset/<hex>` URL, only by a `/sw/img/<hex>` URL, only by uppercase hex, or
  only as an escaped key (a quote, a backslash, a newline) written after the mark; in a tab whose
  `blobCache` holds an inlay's media, after the sweep deleted that file, saving the same bytes under a new id
  uploads them before the new record is written, and with the file present uploads nothing and claims the
  key; `saveAssets` asks the missing check for every key after its queue drains and re-writes, before it
  returns, a key deleted after its batch was sent; the server module import claims every filled key again
  before its result line and republishes one deleted after its skip; a sweep batch that starts while an
  export prepare's worker runs (a latch) waits for its key set and skips its keys, and a key held by an
  upstream export whose download is streaming is skipped until its `finalize`; a re-import that finds a
  candidate's bytes present (through `writeContentAsset`, through `publishStagedContentAsset`, and through the
  module import) takes the key's lock and lease, so the sweep skips the key as leased, and a re-import that
  waits on the lock while the sweep deletes the key publishes the bytes again; a publish that arrives while
  the sweep holds the key's lock lands after the delete and leaves the new file (the lock test with a latch);
  after a restart the sweep is a 409 until `ASSET_LEASE_MS` of uptime has passed (injected monotonic clock),
  and a run of another process or of an earlier epoch is refused even when the `writeCount` values match; an
  incomplete or stale run makes `sweep` a 409; `dryRun` deletes nothing and answers the same list; `keys`
  narrows the run; `inlays` removes a record still orphaned past the grace and skips one a message written
  after the mark names, and the removed record's asset is unreferenced at the next run, not deleted at once; a
  filesystem error on one key is a skip, not a 500, and the batch continues; `writeAssets` with two write
  batches asks the missing check before each; the restore answers 507 from a short injected `statfs` when the
  free space covers twice the snapshot but not the live database's safety snapshot too, and checks again
  before `pin`'s fallback copy when the link is refused; the backup import answers 507 from its declared
  `Content-Length` before saving and, before extracting its database, when the free space covers the staged
  and installed copies and the safety snapshot but not the extracted source database too; the upstream
  commit answers 507 when the free space covers the staged database's install but not the live database's
  safety snapshot (a small import over a large live database); the export prepare answers 507 with
  `{ needed, free }` and writes no staging;
  the snapshot tick skips and logs once on a short disk and resumes when space returns.
- Landed as `dd35ebc52` with these deviations (approved by the orchestrator during the run):
  - Files beyond the list: `server/src/app.ts` (wiring), `shared/assetLifecycle.ts` (the sweep path and
    types), `server/src/http/diskSpace.ts` (`ensureFreeSpace`, `InsufficientStorageError`,
    `liveDatabaseBytes`), `shared/diagnostics.ts` (`ROUTE_TEMPLATES`), `src/lang/en.ts` (three error keys).
    The global API guide has no Asset client section, so `docs/structure/assets.md` took that edit;
    `characters-modules.md` and `chat-pipeline.md` were corrected where they went stale.
  - A gap in D3's premise: a restore's source snapshot could rotate away while the restore validated, leaving
    its assets to the sweep. `snapshots.retain` keeps it out of rotation until the restore drops its staging;
    Slice 3's retention over unpinned snapshots must keep honoring it.
  - The lease is a root in the scan's classification too, so a key uploaded within the hour is never listed
    unreferenced. `saveAssets`'s final check fails closed (rewrites every canonical key when the check fails).
  - User-visible: a card import re-checks the keys its record names (not free-text keys) before
    `addCharacter`, and ends with an error instead of writing the record when a key is gone and its bytes are
    not in hand. The upstream commit's 507 keeps the prepared import, so the same token can retry.
  - D13's turn re-marks the full live store by default and reuses that result for later batches; on the
    audit seed it lasts about 1.7 s idle and 2.8–3.1 s under load (`docs/audit/asset-scan-2026-11-05.md`),
    during which every request waits.

### Slice 3: snapshot pins, labels, manual snapshots, deletion (D8; needs 1; 2 and 3 in either order, one at a time)

Files: `server/src/data/snapshots.ts` (`pins.json`, `setPinned`, `remove`, `snapshotNow({ label })`,
retention over unpinned snapshots, `list` with `pinned` and `label`, `pin` → `stageCopy`),
`server/src/routes/backups.ts` (`POST /api/backups/snapshot` `{ label? }`, `PATCH /api/backups/:id`
`{ pinned?, label? }`, `DELETE /api/backups/:id`, the restore's `stageCopy`), `server/src/data/assetLifecycle.ts`
(a removed snapshot's index rows go with it; the mark's `pin` call becomes `stageCopy`; pins change nothing in
the mark, since every listed snapshot is a root),
`shared/resources.ts` (`BackupSnapshotInfo`), `src/ts/storage/resourceClient.ts` (`takeSnapshot`,
`updateSnapshot`, `deleteSnapshot`), the server resources guide (Snapshots and restore: pins and the cap;
Files; Recipes), the persistence guide only if `BackupSnapshotInfo`'s mention there changes. Not in parallel
with Incremental Chat Transport Slices 1, 3, and 4 (`shared/resources.ts`, and `resourceClient.ts` for 3 and 4).

- Tests (`server/src/tests/snapshots.test.ts`, `backups.test.ts`, `assetLifecycle.test.ts`,
  `src/ts/storage/tests/resourceClient.test.ts`): retention keeps 20 unpinned snapshots and every pinned one;
  the 21st pin is a 409; deleting a pinned snapshot is a 409 and an unpinned one removes the file, its pin
  entry, and its index rows; a manual snapshot carries its label and counts toward the unpinned 20 until
  pinned; a pin whose file is gone is not listed; the restore still works through `stageCopy` while retention
  runs; the mark still indexes through `stageCopy`; the client calls send the right methods and bodies.
- Landed as `0c3e7d2d0` with these deviations (approved by the orchestrator during the run):
  - `heldBytes` is in the report's `snapshots[]` (D9) only, not in `BackupSnapshotInfo` or `GET /api/backups`:
    it needs the whole retention graph. Slice 4 reads it from the report.
  - `setPinned(id, { pinned?, label? })`; an omitted field keeps its current value, resolved inside
    `exclusive`. A label is trimmed, empty is null, over 200 characters is a 400.
  - `remove` also refuses (409) a snapshot a restore holds through `snapshots.retain`. A corrupt `pins.json`
    fails the manager's start (only a missing file is empty); a failed durable write keeps a snapshot pinned
    in memory if either the old or the new state pinned it.
  - The mark re-checks the snapshot file synchronously before writing its index rows, and an `onRemoved`
    listener drops a removed or rotated snapshot's rows. The manual snapshot takes the tick's disk preflight
    (507). The client surfaces a snapshot 409 as `ResourceRequestError` with the server's message.
  - Files beyond the list: `shared/assetLifecycle.ts` (the report's snapshot type), `shared/diagnostics.ts`
    and its test (the backup routes in `ROUTE_TEMPLATES`), `src/ts/storage/tests/resourceClientMock.ts`, and
    `self-host-server.md` (the rename).

### Slice 4: the Storage section of Advanced settings (D9's UI, D14's action; needs 2 and 3)

Files: new `src/lib/Setting/Pages/Advanced/StoragePanel.svelte`, new `src/ts/storage/assetLifecycleClient.ts`
(`readStorageReport`, `startStorageScan`, `sweepAssets` with keys and inlay ids, over `authFetch`),
`src/ts/setting/customComponents.ts`, `src/ts/setting/advancedSettingsData.ts` (section `advanced.storage` with
the custom item), `src/lang/en.ts` and `src/lang/ko.ts` (`storage.*`: the totals, the owner kinds, the
candidate list, the orphan inlay records, the confirmations naming count and bytes, the snapshot actions, the
"shares may exceed the total" note, the incomplete-run notice naming an unreadable snapshot), the settings and
i18n guide (Declarative pages: the section; Tests), the global API guide (Files: the client).

- Tests (new `src/lib/Setting/Pages/Advanced/StoragePanel.test.ts` on the `DiagnosticsPanel.test.ts` pattern,
  new `src/ts/storage/tests/assetLifecycleClient.test.ts`, `src/ts/setting/settingsPageSections.test.ts`,
  `e2e/settingsPages.spec.ts`): the panel reads the report on open and shows totals, shares, candidates,
  orphan inlay records, and snapshots; Scan starts a run and polls until `running` clears; an incomplete run
  disables Delete and shows the reasons, with Delete offered on the unreadable snapshot it names; Delete
  confirms with the count and bytes, sends the selected keys, and shows the skipped keys with their reasons;
  deleting orphan inlay records confirms with their count and sends their ids; the snapshot actions call the
  client with the right ids; Pin on the 21st shows the server's refusal; the section mounts through the
  records without a write (the e2e page sweep).
- Landed as `967cc5be1` with these deviations (approved by the orchestrator during the run):
  - The client's Files entry is in `docs/structure/assets.md`, where the asset client is documented, not the
    global API guide.
  - The snapshot list reads `listBackups()` live and joins `heldBytes` from the report by id (the report's
    list is as of the last scan); the panel says held sizes are as of the last scan.
  - The snapshot actions are disabled while a scan or a sweep runs, since a snapshot taken or restored mid-scan
    makes that run incomplete. An unreadable snapshot is matched to its row through the reason text
    (`snapshot <id>`); the report has no field for it.

### Slice 5: the browser check and the final guide pass (needs 4)

Files: new `util/playwright/checkAssetLifecycle.mjs` (listed in the test-harness guide's Check scripts beside
`checkDurableDrafts.mjs`; it reuses `stack.mjs` and the settle helpers), `util/playwright/stack.mjs`
(`restartServer` takes a server environment, so a restart can set the clock offset), a final pass over every
guide this plan touched, the audit note of Slice 1 extended with the sweep's cost and the synchronous turn's length.

- Driver cases, one dev stack whose server gets `RISU_HOST=127.0.0.1`, with the default grace throughout and
  time moved only by D4's development offset, never a grace of 0: seed a character with a profile image and a
  chat with a generated inlay; the report attributes both (the inlay through its id); delete the character
  and the periodic snapshots taken since seeding (they name both); Scan shows the profile image unreferenced
  and the inlay record orphaned, neither deletable yet; restart the server with an offset past the grace and
  the lease, Scan, and delete the orphan inlay record; Delete removes the profile image and its thumbnail
  directory, and the next Scan shows the inlay's media unreferenced and not yet deletable; restart with an
  offset past a second grace, Scan, and Delete removes the inlay's media; a tab that rendered the image
  before the delete still shows it from its cache, and shows a broken image once the browser's HTTP cache is
  cleared (CDP `Network.clearBrowserCache`) or the URL is requested uncached, since a plain reload keeps the
  immutable entry (`server/src/routes/storage.ts` around 567) (D11); a pinned
  manual snapshot taken before a third key's character is deleted keeps that key alive through a Scan, the
  restore of that snapshot brings the character back with its image intact, and deleting the character
  again, then unpinning and deleting the snapshot, frees the key at the next Scan.
- Device checks (a Docker volume on a nearly full disk for the 507 answers) go to the user as a checklist and
  are reported as not run (V5).

## Recommended order

1 → 2 → 3 → 4 → 5. Slice 1 is invisible to the tab (a new read-only route and a nightly read-only scan) and
starts the grace clocks, so the day Slice 2 lands there are already deletable keys to test against. Slice 3
needs 1; 2 and 3 go in either order, one at a time (both edit `backups.ts` and `snapshots.ts`), so 3 can go
first if the owner wants pins first. Slice 4 is the first user-visible change. Q2 kept automatic deletion in
**Later**, so no slice carries it.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for the renamed export (`pin` → `stageCopy`) and
  for `listAssetKeys` if its shape changes, V6 for every new test (shown failing once with the guarded line
  broken).
- Focused: `pnpm --silent test:agent server/src/tests/assetLifecycle.test.ts server/src/tests/snapshots.test.ts
server/src/tests/backups.test.ts server/src/tests/assets.test.ts server/src/tests/assetRoute.test.ts
server/src/tests/app.test.ts server/src/tests/listenConfig.test.ts server/src/tests/importModule.test.ts
server/src/tests/resourceStore.test.ts server/src/tests/upstreamExportRoute.test.ts
server/src/tests/upstreamImportRoute.test.ts` for the server;
  `pnpm --silent test:agent src/lib/Setting/Pages/Advanced/StoragePanel.test.ts src/ts/storage/tests/assetLifecycleClient.test.ts
src/ts/storage/tests/assetClient.test.ts src/ts/storage/tests/assetQueue.test.ts
src/ts/process/files/tests/inlays.test.ts src/ts/storage/tests/resourceClient.test.ts
src/ts/setting/settingsPageSections.test.ts` for the tab (file names as the slices create them).
- `e2e`: `e2e/settingsPages.spec.ts` after Slice 4 (every settings page mounts without a write); the
  slow tests of the backup routes if `backups.test.ts` gains a `slow` case for a large seeded store (then
  `pnpm check:tests` for the slow-test table). Browser: `util/playwright/checkAssetLifecycle.mjs` after
  Slice 5, one dev stack at a time.
- Not covered by any gate: the full-disk answers on a real volume (the user's checklist), the scan's cost
  and the synchronous turn's length beyond the measurements the audit note records, and keys a plugin keeps only
  in its own storage (D11).

## Out of scope

- A byte budget over snapshots, thumbnails, or assets that deletes referenced data to make room (F08's
  budget), and a byte cap on the thumbnail cache (its Issue stays).
- The tab's fallback asset path (F13): it reads originals without a capable worker; unchanged here.
- Snapshot content browsing, diffs, and per-record restore (HaejeokRisuai C3), and snapshot download as an
  archive (RisuNest item 8's download; the version-2 export covers a live export).
- Retiring `GET /api/remove`: no client calls it, but it is the one explicit delete the tests and the
  thumbnail removal path use; it stays.
- Multi-user servers: the report and the sweep act on the one user's data behind the JWT.

## Later

- The opt-in automatic sweep (`assetAutoSweep`, D10), deferred by Q2.
- A daily snapshot tier (keep one per day for D days) beside pins, if the 10-minute cadence and 20 kept
  rotate away states users want.
- Live progress of a scan or sweep over the live-update feed instead of polling, if runs on large stores
  take long enough to need it.
- Thumbnail-sized delivery on the fallback path (F13), which would let the report's thumbnail bytes mean the
  same thing in every environment.
