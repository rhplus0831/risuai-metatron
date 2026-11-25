# Server resources

## Scope

- Owns the server side of the resources: the SQLite resource store, chat tables, resource kinds and normalization, chat
  checkpoints, snapshots, version-2 and upstream backups, the module, CharX, and Realm import transfers, and their
  routes.
- Shapes and revisions belong to [persistence](persistence.md), chat writes to [chat-store](chat-store.md); the backup
  UI and the client's archive reader to [backup-sync-hub](backup-sync-hub.md).
- Neighbors: [self-host server](self-host-server.md) owns the process, the middleware order, request bodies, limiters,
  auth, asset storage, and the `save/` map. [Server generation](server-generation.md) owns jobs that write the store.
  The [live-update feed](live-update-feed.md) distributes committed changes.

## Files

Each route's body, answer, statuses, and caps are the comment above its registration; the store modules' rules are their
headers and method comments.

### Store and chats

- `server/src/data/resourceStore.ts` `createResourceStore` (`ResourceStore`: `applyChanges`, `readRefs`,
  `readRefsWithinBudget`, `listRevisions`, `replaceAll`, `onChatInvalidated`; `walkSnapshotFile`, `readSnapshotFile`,
  `writeValidatedStore`, `normalizationStamp`): the SQLite store, its open, and its install.
- `server/src/data/chatStore.ts` (`openChatSchema`, `createChatTables`, `chatSummary`, `applyGroup`, `copyStagedChats`)
  and `server/src/data/chats.ts` (`normalizeChatMeta`, `normalizeMessage`): the chat tables, their summaries and memos,
  and chat validation.
- `server/src/data/kinds.ts` declares normalization, projection and patch behavior in `DEFAULT_RESOURCE_KINDS`
  (`ResourceKind`), with per-kind normalizers in `server/src/data/normalize/`. For input-hook and folder lists, follow
  `server/src/data/normalize/collections.ts` to `shared/inputHooks.ts` and `shared/itemFolders.ts`. For plugin storage's
  nested dictionaries and the plugin list's name-keyed patches, follow `PLUGIN_STORAGE_DICTIONARIES` in
  `shared/pluginStorage.ts` and the kind declarations.
- `server/src/data/checkpointStore.ts` (`createCheckpointTables`, `walkCheckpointSnapshot`) and
  `server/src/data/checkpointService.ts` (`createCheckpointService`: `save`, `load`, `autoSave`): checkpoints.
- `server/src/data/chatTrashPurge.ts` (`createChatTrashPurge`), the [purge](#chat-trash-retention).
- `server/src/data/snapshots.ts` (`createSnapshotManager`: the timer, `stageCopy`, `withMaintenance`;
  `MaintenanceGate`), `server/src/data/archive.ts` (the version-2 archive records),
  `server/src/data/databaseProjection.ts` (the flat `Database` projection of a job's scope and the upstream export), and
  `server/src/data/recordPatchText.ts`.
- The store publishes on the [feed](live-update-feed.md#coalescing-and-publish-order).

### Backup and import internals

- `server/src/data/restore/` validates a restore's database in a worker and writes its staged store
  ([Validation](#validation)); `server/src/data/upstream/` reads and writes RisuAI-compatible `.bin` saves in workers
  (`{import,export}{Runner,Stage}.ts` here; `risuSave.ts`, the codec, and the converters are
  [backup-sync-hub](backup-sync-hub.md)'s).
- `server/src/http/spool.ts`, `server/src/http/fileImport.ts` (`serveFileImport`, `serveStagedImport`,
  `createImportSlot`), `server/src/http/contentAsset.ts`, and `server/src/http/recordStream.ts` handle archive and card
  file transfer for the routes below.
- An existing content-named asset (`assets/<sha256 hex>.<ext>`) is kept only when it holds its bytes
  (`holdsVerifiedAsset`): the file imports replace a damaged one by rename, and `restoreValidated` (`routes/backups.ts`)
  when the archive's copy hashes to the name. A restore never overwrites other existing names.

### Resource routes

`server/src/routes/resources.ts` `registerResourceRoutes` and `server/src/routes/resourceBoot.ts` (`parseBootRequest`,
`readBoot`): JWT (`checkAuth`) and authenticated limiter. Only writes need the [epoch](#epoch-and-response-rules).
Proxies must preserve encoded ids ([Gotchas](self-host-server.md#gotchas)). Shapes: `shared/resources.ts`
(`ResourceBootRequest`, `ResourceBootResult`, `ChatReadRecord`) and `shared/chats.ts`.

- Reads: `GET /api/resources?kinds=` (whole kinds, one committed state), `POST /api/resources/read` (named records,
  chats, rows, and collections; the [read budget](#read-budget)), `POST /api/resources/boot` (skips what the tab holds),
  `GET /api/resources/revisions` (revision refs), `GET /api/resources/:kind`, and `GET /api/resources/:kind/:id`, all
  compressed per `Accept-Encoding` (`compressedJson`).
- Writes, + epoch: `POST /api/resources/batch` (resource ops, chat groups, chat orders; a conflict applies nothing),
  `PUT` and `DELETE /api/resources/:kind/:id` (`baseRevision`; 409 with the current revision).
- Write patches: `preparePatch` and `writePatch` apply nested and `itemKey` forms (`shared/recordPatch.ts`) and older
  clients' top-level and id-keyed ones. The feed's `entryPatch`, which older tabs ignore, carries changed entries and
  name-keyed item diffs ([client side](live-updates.md#live-updates)).
- `revisions?since=&until=&epoch=`: coalesced refs/tombstones (`ResourceChangesSince`); no `since`: whole listing.
  Bounds require nonnegative safe integers and epoch nonempty (else 400). Coverage/expiry: `resourceStore.ts`
  `listChanges`; epoch checks match listings.

### Credential routes

`server/src/routes/llmSecrets.ts` `registerLlmSecretRoutes`: JWT + epoch, authenticated limiter.
`PUT /api/llm-secrets/<path>` sets and `DELETE` clears one credential; both answer the masked record.

### Message search route

`server/src/routes/messageSearch.ts` `registerMessageSearchRoutes` validates and admits `POST /api/chats/search`
(`MessageSearchQuery`, `MessageSearchPage` in `shared/messageSearch.ts`). `resourceStore.ts` `searchMessages` owns the
budget and cursor. Its newest-first walk in `chatStore.ts` uses literal matching with SQLite's ASCII-only case folding.
Follow the [chat search client](chat-pipeline.md#slash-commands-groups-and-search) when changing snippet offsets or
continuation.

All scopes and continuations skip trash. A trashed chat's own scope returns an empty page. A missing chat gives 404.

### Chat checkpoint routes

`server/src/routes/chatCheckpoints.ts` `registerChatCheckpointRoutes` over `createCheckpointService`: JWT, authenticated
limiter, `no-store`; writes also need the epoch. `GET /api/chat-checkpoints` and `/policy`, `PUT /policy`, and `POST`
`save`, `rename`, `delete`, `load` ([chat writes and checkpoints](#chat-writes-and-checkpoints)).

### Backup routes

`server/src/routes/backups.ts` `registerBackupRoutes`: `checkAuth`, authenticated limiter; the epoch applies to the
restore and the import only. `GET /api/backups`; `POST /api/backups/snapshot`, `PATCH`/`DELETE /api/backups/:id`;
`POST /api/backups/:id/restore` ([restore](#snapshots-and-restore); it never reads its body,
[Limitations](self-host-server.md#limitations)); `POST /api/backups/export` and `POST /api/backups/import`
([export and import](#archive-export-and-import)). The import's raw body has no 100 MiB limit: `RISU_MAX_IMPORT_BYTES`
(`DEFAULT_MAX_IMPORT_BYTES`, 16 GiB) caps it and the upstream, module, and CharX uploads.

### Upstream backup routes

`server/src/routes/backupsUpstream.ts` (`registerUpstreamImportRoutes`, `createUpstreamImportStaging`) and
`server/src/routes/backupsUpstreamExport.ts` (`registerUpstreamExportRoutes`, `createUpstreamExportStaging`):
`checkAuth`, authenticated limiter. `POST /api/backups/import-upstream/prepare` and `/commit` (+ epoch; NDJSON lines in
`shared/upstreamBackup.ts`) and `/cancel`; `POST /api/backups/export-upstream/prepare`
(`shared/upstreamExportReport.ts`) and `/cancel`, `GET /api/backups/export-upstream/download`
([upstream backups](#upstream-backups)).

### File import routes

`server/src/routes/importModule.ts`, `server/src/routes/importCharx.ts`, and `server/src/routes/importRealm.ts`
(`createRealmStaging`; the PNG card plan of `server/src/routes/importPng.ts`): `checkAuth`, authenticated limiter, no
epoch; NDJSON answers in `shared/moduleImport.ts`, `shared/charxImport.ts`, and `shared/realmImport.ts`.
`POST /api/import/module`, `POST /api/import/charx`, and `POST /api/import/realm` with `/commit` and `/cancel` (the
Realm bodies capped at 4 KiB).

## Flows

### Epoch and response rules

- "+ epoch" means the `x-resource-epoch` header must name the current database epoch (412
  `{ error: "EpochMismatch", epoch }` otherwise).
- Mutations answer 503 with `Retry-After` while the maintenance gate is closed (a restore's or an import's install;
  their validation and the staged file's hash run outside it). During shutdown, new resource requests (including reads),
  backup requests, and module, CharX and Realm imports also answer 503 with `Retry-After`; a typed store-closed error
  maps to the same retryable response.
- `/api/resources` responses are `Cache-Control: no-store` (the routes' `noStore` middleware), and `/api/llm-secrets`
  sets it on a success. Every read route and the PUT response answer a kind with `project` in its projected form:
  `llmSecrets` is masked.
- Every whole chat a read returns (`/api/resources/read` `chats` and `chatCollections`, `/api/resources?chats=1`)
  carries `streaming`, the chat's generation locks taken from `generationJobs.streamingSnapshot()` in the same
  synchronous step as the store read (`ChatReadRecord`), so the list matches the chat's revision; a missing chat and a
  summary carry none.
- The tab replaces the chat's feed locks with it ([feed locks](live-updates.md#feed-locks)); a client must treat the
  field as optional.

### Read budget

`POST /api/resources/read` deduplicates its entries, always. With `continue: true` one answer is bounded by its charged
bytes (`readResponseBytes`, default `MAX_READ_RESPONSE_BYTES` in `shared/resources.ts`, 16 MiB) and names what it left
out in `unanswered`; without it the answer is whole, so an older tab that takes an absent entry for a deleted one never
meets `unanswered`. The budget is soft: an answer's first group is served whatever its size, so an entry that outgrew it
stays readable, and a chat or a collection is never split. The groups, their order, and the charge (a
[projection](structured-memory/projection.md#the-hypav3-projection) read, asked by the routes and done under structured
memory, charges stored `memory_events` only for eligible chats) are `readRefsWithinBudget`'s comment. A `chatRows` entry
is one budget group, charged its named rows and, when metadata fields are requested, the whole stored metadata. A served
entry answers stored rows and fields (no projection) at the requested revision, or `moved` with the current revision
(null: gone). Unserved entries appear in `unanswered.chatRows`; a moved entry costs zero but remains subject to the
group-order cutoff.

### Chat summaries

- `chatSummary` (`chatStore.ts`), over the stored `chatSummaries.text`, answers the full summary listing, collection
  summary reads, and single-chat binding reads; a feed chat entry's `summary` has the same fields (`summaryWithTime`); a
  fresh projection is read without `meta` ([Summary projection](#summary-projection)).
- List reads include per-chat translation and memory settings projected by `chatTranslationSummary` and
  `chatMemorySummary`. `lastMessageAt` comes from the final row by position when it has a finite numeric time.
  `lastMessageTimes` in `createChatTables` defines invalidation and transaction rules.

### Chat activity

Ordinary send, continue, reroll, and group jobs write chat activity without changing the character or group resource
revision; explicit character effects (memory enable, triggers, Lua setters) still write it. Continue sets the continued
message's time in its final write (the existing one when streamed); preview and previewPrompt change neither activity
nor character revision. The stored `lastInteraction` remains a frozen legacy fallback; the client derives last-chatted
ordering from chats ([chat store](chat-store.md#last-chatted)). Upstream export keeps its own cold-storage rule: raise a
numeric legacy value to the newest chat `lastDate`, but leave absence as absence (upstream reads it as now).

### Chat writes and checkpoints

- The client save adapter batches resource, chat, and order changes through `/api/resources/batch`; conflicts roll the
  batch back.
- A chat group's ops follow the `ChatOp` contract (`shared/chats.ts`), enforced in `chatStore.ts` `applyGroup`: a group
  id its chat incarnation remembers returns its earlier result without applying again or publishing a chat feed ref, and
  a group with a non-null base below the chat's restore floor conflicts (`selectRestoreFloor`).
- [Own chat changes](live-update-feed.md#own-chat-changes) and [feed entries](live-update-feed.md#feed-chat-entries)
  stay out of the HTTP results.
- A checkpoint load (`checkpointService.ts` `load`) checks the current chat and generation locks, then in one
  transaction takes a safety checkpoint, applies the replacement and
  [the memory records](structured-memory/lifecycle.md#a-checkpoint), and sets the restore floor; the commit invalidates
  retained memory-task input (`onChatInvalidated`).
- Automatic checkpoints (`autoSave`) run only after a job ends with a final `done`, when the chat policy's user-turn
  threshold is met (`countUserTurns`, no message row read).
- By-id writes read touched rows by id (`TOUCHED_ROWS_SQL`); `messageCount` uses the `messageCounts` memo when available
  and falls back to `COUNT(*)` on a miss.
- Reroll snapshots (`scriptstateCheckpoint`, candidates' `scriptstateAfter`) follow position: after an `append` only the
  newest non-comment message or a live job's row keeps them; `setMessage`/`patchMessage` cannot restore them on a row
  holding none unless an admitted generation or the lock owner writes (`candidateRows` reports `cleared`).

### Chat Trash

- `server/src/routes/chatTrash.ts` handles `POST /api/chat-trash/{trash,restore,delete}` with
  `{ characterId, chatId, revision }` and the epoch header. `changeChatTrash` commits and publishes changes. A 200
  returns revision, mark, and summary, using pre-delete state for `delete`. An already satisfied trash or restore is a
  no-op.
- Trash and restore accept older tokens of the same incarnation. Delete needs the exact revision of a trashed chat. A
  409 reports `stale`, `notTrashed` for deleting an active chat, `lastActiveChat` for trashing the last active chat, or
  `generating` when `chatHeld` blocks trash or delete. Restore clears the mark regardless of job holds.
- After receipt replay and retry expiry, legacy batch deletes of existing chats get `useTrash`. Trashed chats reject
  writes with `chatTrashed`, including translation commits and checkpoint mutations. Checkpoint listing works and
  `autoSave` skips trash. [Tab conflict recovery](resource-sync.md#chat-and-order-conflicts).
- Trash blocks generation after request-id replay, manual memory tasks, and translation even on follow-up. The
  Structured Memory `fenced` predicate and rebuild abandonment check the mark. Trash invalidation cancels queued and
  running memory tasks, bypassing `noteSourceReplaced` and leaving no stop reason so paused rebuilds can resume.

### Chat Trash retention

`startBackgroundTasks` starts one timer (one minute, then hourly). Runs skip maintenance. `beginShutdown` stops the
timer and disposal drains the purge before store close. Each run scans `expiredTrashedChats` using
[`chatTrashDays`](settings-i18n.md#pages). `changeChatTrash("delete")` rechecks epoch, revision, mark, cutoff, and
`chatHeld` in the delete transaction. Eligible skips retry next run.

### Snapshots and restore

- `createSnapshotManager`'s comment has the timer, retention, pins, removal, and disk check.
- A restore checks the epoch, then in a `createRestoreQueue` turn (`routes/backups.ts`) retains the snapshot
  (`snapshots.retain`), checks disk (507), links it (`snapshots.stageCopy`), [validates](#validation) it outside
  maintenance, then under `withMaintenance` checks the epoch, takes a safety snapshot, and [installs](#install). A
  client that leaves does not cancel it.
- A write admitted before the gate closes commits without moving the epoch, so the restore's check still passes: the
  write is in the safety snapshot and is replaced by the install, and the tab's next write meets the new epoch (412).

### Archive export and import

The version-2 export and import contracts are the comments above their routes in `routes/backups.ts`: a
`data/exportScrub/` worker removes `llmSecrets` from the export's copy; the import checks the whole archive's records
against its manifest (`planImport`), validates its database in a restore queue turn, then installs under maintenance by
the [content-name rule](#backup-and-import-internals). Asset bytes are not part of the archive check: a content-named
asset that is added, not repaired, is linked even when it does not hash to its name, and `restoreValidated` records the
mismatch (`assetVerification.recordVerification`).

### Validation

`server/src/data/restore/stageValidatedSnapshot.ts` `stageValidatedSnapshot` runs every check in one walk
(`walkSnapshotFile`), whose sink is the raw validated-row writer (`writeValidatedStore`: what stays as stored, what is
compacted, what is left out) or, for the upstream export, `readSnapshotFile`.
`server/src/data/restore/validateRunner.ts` runs it in one `worker_threads` thread per restore under
`RISU_RESTORE_HEAP_MB` (default 2048); its header has the in-process cases, `restore.runner`, and how each failure
answers.

### Install

`verifyStagedFile` re-checks the worker's report on the serving thread, then `replaceAll(stagedFile, report)` copies the
staged rows into the live store in one `BEGIN IMMEDIATE` transaction; the order, the seq maps, and what changes only
after the commit are its comment.

Snapshots and v2 archives carry the mark. `assertSnapshotHeader` accepts both layouts at this schema version.
`walkChatSnapshot` reads older rows as active. Staging uses the current layout. `copyStagedChats` restores a character's
most recently trashed chat if all were trashed and restamps remaining trash at one install time.

### Shutdown during a restore

Shutdown aborts a restore before its install (`restoreShutdown` in `app.ts`; `restoreSignal`'s comment in
`routes/backups.ts` has where it is checked), answering 503 with its staging removed. An upstream commit stops the same
way (`staging.signal`). A version-2 import admitted before shutdown finishes, and `dispose` waits for it.

### Upstream backups

- Upstream `.bin` import and export use prepare/commit or prepare/download flows. Conversion runs in a worker with a
  heap cap; staged work expires after ten minutes. `RISU_MAX_UPSTREAM_DB_BYTES` caps the decoded database.
- Import prepare checks the disk reserve before spooling declared uploads and before worker extraction of indexed assets
  (507 on shortage); commit rechecks installation space.
- Import prepare's worker uses `stageValidatedSnapshot` on its build store and default kinds (`importStage.ts`).
- Import reports changes for review; the commit's recheck, its 412 and `409 changedSinceReview`, and when the import is
  handed back are the comment above the commit route.
- Export reads the snapshot without checkpoint tables, so upstream saves hold no named checkpoint history. The flat save
  uses the eligible chats' memory projections and reports the count of omitted pages and threads. A failed memory walk
  leaves the rest exportable ([projection](structured-memory/projection.md#the-hypav3-projection)).
- `exportDatabase.ts` omits `chatTrashDays` and filters trash before deriving `chatPage`.

### File imports

`.risum`, CharX, and Realm validate before asset publication. Module/CharX uploads spool to disk and report failures
after NDJSON starts as terminal errors; Realm stages contents before asset commit and shares their import slot. CharX,
including Realm's reader, checks the disk reserve before each decoded asset; shortages end with `Disk is full`,
retaining published assets for sweep. CharX admits declared uploads before spooling (507 `Disk is full` on shortage).

### Maintenance

Maintenance closes new resource and storage mutations and waits for admitted writes. Restore and backup imports use the
maintenance gate; the asset sweep uses only `exclusive`. Jobs, transforms, and memory tasks stop for it
([job state](server-generation.md#process-memory)).

## State

Paths are under `save/` ([Disk layout](self-host-server.md#disk-layout)). `backups/` holds the resource snapshots
(`resources-*.sqlite`, single files, newest 20 unpinned plus pinned ones, `pins.json`); assets are not in snapshots, and
the [asset ledger](self-host-server.md#asset-mark) indexes each one's references once.

### Store tables

`data/resources.sqlite` holds the resource and chat records. It uses WAL and schema version 3. Versions 1 and 2 use a
root settings record and cannot be opened or restored here.

- `server/src/data/resourceStore.ts` `STORE_TABLES_SQL` defines resources and metadata, including the epoch,
  normalization stamp and summary projection version. `server/src/data/chatStore.ts` defines chats, ordered messages,
  generation fences, chat orders and the indexes used for by-id edits, last-message reads and checkpoint cleanup.
- `chats.trashedAt INTEGER` holds server-clock milliseconds or null for active chats. `openChatSchema` adds it if
  missing (`PRAGMA table_xinfo`). Ordinary writes preserve it, and `meta.trashedAt` is custom metadata.
- The store records revision refs and tombstones in `changes` in the write's transaction. Open-time maintenance bypasses
  the log. Reconnect reads it through `listChanges`; a whole-store replacement drops its entries while preserving the
  cursor sequence. Snapshot copies include the log, and restore ignores it.
- `chatGroups` keeps idempotency receipts for a chat incarnation. The local checkpoint barrier in `chatRestoreFloors`
  also belongs to that incarnation. Both survive restart and are cleared by whole-store replacement. The
  [checkpoint](#checkpoint-tables) and [memory](structured-memory/records.md#memory-tables) groups are optional snapshot
  data.

### Summary projection

- `chatSummaries` (`chatSeq` primary key referencing `chats.seq` with `ON DELETE CASCADE`, `revision`, `text`) is each
  chat's summary projection (`summaryText`: the listed metadata fields as JSON, without `lastMessageAt`, `trashedAt`, or
  the revision), created the same way and outside the layout check: `backupTo` copies it into every snapshot, validation
  ignores it, and a restore writes its own rows.
- Reads add `ChatSummary.trashedAt` from the column when marked. `ChatRecord.trashedAt` carries the nullable mark.
- `writeChatMeta` is the only live writer of `chats.meta` and stores the projection in the same transaction (a
  [restore's writers](#invariants) write both tables together); every other chat write moves the row's `revision` with a
  compare-and-set, so a row an older server left behind never turns fresh. A row is fresh when its `revision` equals the
  chat's.
- `openChatSchema` runs in its own transaction after the normalization pass and before any chat statement is prepared:
  it rebuilds missing and stale rows, and every row when `summaryProjectionVersion` differs from
  `SUMMARY_PROJECTION_VERSION` (bump it when the shape changes). A `meta` that cannot be projected rolls that
  transaction back and closes the store, stopping the open.
- For summary-shape changes, follow [Boot cache](resource-sync.md#boot-cache) and the `CHAT_SUMMARY_FORMAT` contract in
  `shared/chats.ts` as well as the stored projection version.
- A reader that finds a stale or missing row computes it from `meta` and rewrites it outside a transaction, best-effort,
  as neither a store write nor a feed event; inside a transaction it answers the computed text and writes nothing.

### Checkpoint tables

`server/src/data/checkpointStore.ts` `CHECKPOINT_SCHEMA_SQL` defines `chatCheckpoints`, content-addressed
`checkpointPages`, `checkpointPageRefs` and `chatCheckpointPolicy`. A snapshot may omit the entire group.
`walkCheckpointSnapshot` validates a present group with `snapshotTableGroup` and checks ordered message pages, field
hashes and the [memory manifest](structured-memory/lifecycle.md#a-checkpoint). `chatRestoreFloors` is outside that
group.

Deleting or pruning a checkpoint removes its newly unreferenced pages in the same transaction. Chat deletion can leave
pages for store open or a scheduled [asset mark](self-host-server.md#asset-mark) to collect. Restore keeps referenced
pages only.

### Store open and normalization

- `resourceStore.ts` `createResourceStore`, `normalizeStoredRecords`, `normalizationStamp`: normalization and stamp
  contracts. Rewrites retain `seq` and epoch. An [install](#install) runs no pass.
- A version-1 or version-2 file (settings in a `root` record) is refused at startup with a message naming it, and a
  snapshot or archive of another version is refused on restore; this server does not migrate those database versions.

### Store connection

The connection runs with `journal_mode=WAL`, explicit `synchronous=FULL`, `busy_timeout=5000`, and `foreign_keys=ON`, so
acknowledged resource writes do not depend on the SQLite build default. `RISU_SQLITE_SYNCHRONOUS=normal` (`full` is the
default) replaces `FULL` on this connection only, for SD cards and slow local volumes, not network filesystems
([Limitations](#limitations)). Request history, job receipts, and the vector cache keep `synchronous=NORMAL` regardless.

### Process memory

- The resource store's epoch and committed-write counter, the snapshot lock, the maintenance gate, the restore queue,
  the backup import slot (the version-2 import and the upstream prepare and commit), the import slot the module, CharX,
  and Realm imports share, the staged Realm imports (`realmStaging`), and the prepared upstream imports
  (`upstreamStaging`) and exports (`upstreamExportStaging`).
- The source-generation map tracks chats deleted or replaced whole since open or restore. The store also owns listener
  sets for `onChatInvalidated` and `onMessagesChanged`.

## Coupling

- [Self-host server](self-host-server.md): [Routes](self-host-server.md#routes),
  [Rate limits](self-host-server.md#rate-limits), [Request bodies](self-host-server.md#request-bodies), and its
  [Invariants](self-host-server.md#invariants) for file publication and the one-process rule.
- [Live-update feed](live-update-feed.md#publication-budget): the store publishes each commit to it.
  [Server generation](server-generation.md): jobs write through the store under its
  [token rule](server-generation.md#invariants), and `onChatInvalidated` has one production listener,
  `memoryTasks.invalidate` (`app.ts`). The transform loader does not subscribe: `prompt/displayScope.ts` keys its
  transcript cache by `chatSourceGeneration`.
- Committed message rewrites and retractions reach
  [memory reconciliation](structured-memory/lifecycle.md#retraction-and-edits) via `onMessagesChanged`; speaker changes
  are identified even when a legacy content hash would miss them.
- [Resource sync](resource-sync.md) and [backup-sync-hub](backup-sync-hub.md) hold the client side.

## Invariants

- Mutations carry the current resource epoch; stale epochs fail without writing. Resource revisions, chat groups,
  restore floors, generation write fences, and optimistic recovery are detailed in
  [chat store](chat-store.md#restore-floor). The resource store publishes a change only after commit
  ([Publication budget](live-update-feed.md#publication-budget)).
- Restore and import install under maintenance, after a safety snapshot, with ordinary resource reads open during
  maintenance. The store replaces its resource state atomically, in one transaction: a rollback leaves rows, epoch,
  write count, memos, and the feed as they were, and a commit makes every earlier token stale and publishes one `epoch`
  event.
- Imports and restores follow the [content-name rule](#backup-and-import-internals).
- A restore installs only a staged file this process wrote: exclusive, closed before it is reported, owned by its route
  until the install, and verified against the report. No row is checked on the serving thread for a restore, and
  `replaceAll` parses none; every check lives in the one walk (`walkSnapshotFile`), whatever its sink.
- A restore's staged writer and the install's copy are the only writers of `chats.meta` and `chatSummaries` past
  `writeChatMeta`.
- `llmSecrets` is write-only: reads return the masked projection, never credential values. Provider requests resolve
  them [server-side](server-generation.md#invariants).

## Recipes

- Add a resource kind: add a `ResourceKind` to `DEFAULT_RESOURCE_KINDS` with a pure, idempotent `normalize` (throw
  `ResourceValidationError` to reject), a `schemaVersion`, `singleton` if it has one record, and `materialize` if the
  store should create that record (then `normalize(undefined)` must return its default); the routes, snapshots, and
  archives pick it up. Add the kind name to `RESOURCE_KIND` and set its `BOOT_CACHE_ELIGIBILITY` in
  `shared/resources.ts`. For a settings collection, follow [field ownership](persistence.md) for section membership and
  its client view.
- Change the archive format: `server/src/data/archive.ts`, `planImport` and the export in `routes/backups.ts`,
  `BackupArchiveManifest`, and the client reader in `src/ts/drive/backuplocal.ts`; bump the manifest version.
- Add a table a restore carries: its DDL in one of the schema strings a staged store shares with the live store
  (`STORE_TABLES_SQL`, `CHAT_OPEN_SCHEMA_SQL`, `CHECKPOINT_SCHEMA_SQL`), its checks in the walk (`walkSnapshotFile`),
  its row in the sinks (the staged writer's, and `readSnapshotFile`'s when a reader uses it), and its copy in the
  install (`copyStagedChats`, `copyStagedMemory`, `copyStagedCheckpoints`, or `replaceAll`), through a seq map when it
  references a seq.

## Tests

[Shell tests](self-host-server.md#tests) describe the in-process fixture. Run worker and other timed checks through the
[slow-test table](test-harness.md#slow-test-table).

- `restore.runner` replaces what stages a restore, and `upstreamImport.runner` runs an upstream prepare in process.
- In `backups.test.ts`, export admission is `snapshots.exclusive`; staged-directory visibility alone does not prove it
  has entered the queue.
- Store, chats, and checkpoints:
  `pnpm --silent test:agent server/src/tests/{resourceStore,chats,chatStore,chatSummaries,chatCheckpoints,chatCheckpointRoutes,sqliteSynchronous}.test.ts`.
- Routes:
  `pnpm --silent test:agent server/src/tests/resources server/src/tests/{resourceCompression,messageSearch}.test.ts`.
- Snapshots, archives, and imports:
  `pnpm --silent test:agent server/src/tests/{snapshots,backups,importModule,importCharx,importRealm}.test.ts server/src/tests/upstream`.
- Not tested: `upstream/importRunner.ts` `runUpstreamImportWorker` rejecting a clean worker exit without a result.
  `routes/backupsUpstream.ts` `registerUpstreamImportRoutes` committing while a generation job runs and observing that
  job end through maintenance is also untested; the route tests observe a maintenance listener only.

## Known Hazards

### Limitations

- An in-flight translation can commit after restore. While trashed its commit fails, wasting the model call. Decision:
  owner, 2026-11-22 (restore keeps chat identity).
- A snapshot, restore, or import step whose file I/O never returns holds what queues behind it, with no deadline: later
  snapshot create, pin, edit, and remove (one `exclusive` chain), every resource write (503 `Maintenance in progress`
  while a restore drains or installs), an archive validation behind a restore, and imports of the same slot (409
  `Another import is running` until staging cleanup settles). Decision: owner, 2026-11-24 (reproduction round), as for
  the [stalled disk](self-host-server.md#limitations).
- `server/src/routes/resourceBoot.ts` `bootItems` recomputes every item's hash in a stale item-kind record on each boot
  read; the client's cache saves transfer bytes, but there is no server hash cache to save this work. Decision: Boot
  Resource Cache S4, [archive](../archived-plan/README.md).
- Every listed snapshot is an [asset mark](self-host-server.md#asset-mark) root, so its assets stay until it rotates
  away or is deleted. Decision: Asset Lifecycle D3, archive.
- The SQLite resource store assumes one server process and a local filesystem
  ([Invariants](self-host-server.md#invariants)). Network filesystems are unsupported. Decision: Server Byte Budgets Q1,
  archive.
- `RISU_SQLITE_SYNCHRONOUS=normal` trades durability for commit time: commits skip the WAL fsync, so a power failure or
  OS crash may lose the latest acknowledged commits (no fixed window); the database stays consistent and a process crash
  loses nothing. The client's draft journal drops what an acknowledged commit carried, so a lost commit is not
  recovered. Decision: Server Byte Budgets Q1, archive.
- A restore keeps four things on the serving thread: the install's SQL copy, one synchronous transaction that blocks
  every request for its length, reads included (and leaves a WAL about the size of the database for the checkpoint after
  it); the safety snapshot's `backupTo`; the asset links; and the re-hash, whose chunks yield. The install's time grows
  with the store and the longest chat ([measured](../reports/measurements/server/server-measurements-2026-11-01.md)).
  Decision: Server Byte Budgets D5, archive.
- The restore worker's and the upstream workers' heap limits (`RISU_RESTORE_HEAP_MB`, `RISU_UPSTREAM_IMPORT_HEAP_MB`,
  `RISU_UPSTREAM_EXPORT_HEAP_MB`) bound the V8 heap only, not Buffers or SQLite memory, and an inherited
  `--max-old-space-size` overrides them.
- One row far larger than that limit can abort the whole process instead of ending the worker
  ([observed](../reports/measurements/server/server-measurements-2026-11-01.md)): the store and epoch stay as they were,
  and the next start empties the staging. At the default 2048 no row the 100 MiB request cap admits reaches it; a much
  lower limit can. Decision: a ceiling against a runaway file, not process isolation
  (`server/src/data/restore/validateRunner.ts` header; V8-only scope, Server Byte Budgets D5, archive).
- Validation reads as it checks and stops at the first refusal in reading order (a refused row is reported before a
  later unreadable one); a walk never holds a whole table (`walkSnapshotFile`).
- The upstream import stages on the default kinds, as the export reads with them, so a store with custom kinds is
  supported by neither. Decision: `data/upstream/importStage.ts` and `exportStage.ts` headers.
- Upstream export holds its records, projected database, and encoded save in memory; staged exports are capped at four
  (`shared/upstreamExportReport.ts`). An asset of 4 GiB or more cannot fit an archive record
  (`server/src/data/archive.ts`) and is reported as missing. Decision: Upstream .bin Compatibility S7, archive.
- `GET /api/resources?kinds=…` (the boot-cache miss path and the boot fallback) and `GET /api/resources/:kind` answer
  whole kinds outside the read budget (no `unanswered`), at a cost that grows with the data. One read must stay one
  committed state for the boot; a paged form would need `unanswered` and has no design yet.
- The [read budget](#read-budget) is soft: a chat or a collection past 16 MiB answers whole (append groups grow a chat
  with no lifetime ceiling; the 100 MiB cap is per request), a client without `continue` is answered whole, and the
  budget charges stored bytes, not wire bytes or heap. Nothing bounds how many large answers are in flight, and
  `readRefs` and `JSON.stringify` still run on the serving thread. Decision: Server Byte Budgets D2, D3, and Q3,
  archive.
- The change log is bounded by rows ([Store tables](#store-tables)): ids may be 512 UTF-16 units, so 20,000 rows made an
  82 MB database in a 2026-11-05 probe (a few MB with UUID ids), and the `DELETE` prune never shrinks the file. Every
  kept snapshot (20, plus up to 20 pinned) and backup carries it, so size snapshot storage as rows × id length.
  Decision: Found Issues Clearance Q4 (owner, 2026-11-09): a byte bound costs a `SUM(length(id))` per prune, and a
  VACUUM would stall every commit.
- A version-2 export (`server/src/routes/backups.ts`) opens a custom-key asset while it streams without
  `claimAssetKey`'s lock, so a custom-key write (`server/src/routes/storage.ts`) during the export can pair the
  archive's database copy with later bytes; content-hash keys cannot change. Decision: Found Issues Clearance Q5 (owner,
  2026-11-09): custom keys are mutable by contract, and holding the lock across a stream would block the writer.
- `normalizeCharacterOrder` validates only a folder's `data` members (non-strings are dropped) and keeps a folder whose
  `id`, `name`, or `color` is missing or malformed, since older saves hold such folders; the boot repair tolerates them.
  Decision: owner, 2026-11-10 (known-issues review): a normalizer does not drop legacy data.

### Gotchas

- `server/src/data/chatStore.ts` `chatFeedChange` captures changed metadata field names at write time for its row
  manifest; `readRows` has only current metadata and cannot reconstruct that diff from stored history, so preserve those
  names when changing the feed format.
- Large backup, module, CharX, and upstream backup uploads share Node's four-hour whole-request timeout.
- Resource depth validation runs on parsed JSON after serialization; the HTTP body cap bounds uploads, but in-process
  callers can spend more work before rejection.
- A matching `meta.normalizationStamp` skips the record scan: it names the running-server commit,
  `NORMALIZATION_VERSION` (`data/resourceStore.ts`), and each registered kind's name and schema version. Its identity is
  `resolveNormalizationIdentity` ([build info](build-test-platforms.md)), not the served client's build id. Unknown or
  dirty identity and injected kinds disable the skip and remove the old stamp. Every open still removes retired kinds,
  creates missing materialized singletons, and runs `openChatSchema`.
- A record its normalizer would now refuse stops startup, with its kind and id, only on a run of the pass.
- Normalizers depend only on code and the registry, not configuration or the environment; bump `NORMALIZATION_VERSION`
  for an output change git cannot see (every commit changes the stamp).
- A server from before the stamp ignores it, so running one and then returning to the very commit that wrote the stamp
  skips the pass until the next commit.
