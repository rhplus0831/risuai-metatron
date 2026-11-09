# Server resources

## Scope

- Owns the server side of the resources: the SQLite resource store, chat tables, resource kinds and normalization, chat
  checkpoints, snapshots, version-2 and upstream backups, the module, CharX, and Realm import transfers, and their
  routes.
- Shapes and revisions belong to [persistence](persistence.md), chat writes to [chat-store](chat-store.md); the backup
  UI and the client's archive reader to [backup-sync-hub](backup-sync-hub.md).
- Neighbors: [self-host server](self-host-server.md) owns the process, the middleware order, request bodies, limiters,
  auth, asset storage, and the `save/` map; [server generation and live channels](server-generation.md) owns the jobs
  and the live-update feed this store publishes to.

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
- `server/src/data/kinds.ts`: kind declarations (`DEFAULT_RESOURCE_KINDS`, `ResourceKind`), with normalizers in
  `server/src/data/normalize/`. `pluginStorage` declares `nestedFields: PLUGIN_STORAGE_DICTIONARIES`
  (`shared/pluginStorage.ts`); `plugins` permits `itemKey: "name"`.
- `server/src/data/checkpointStore.ts` (`createCheckpointTables`, `walkCheckpointSnapshot`) and
  `server/src/data/checkpointService.ts` (`createCheckpointService`: `save`, `load`, `autoSave`): checkpoints.
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

`POST /api/chats/search` (`server/src/routes/messageSearch.ts` `registerMessageSearchRoutes`): `checkAuth`,
authenticated limiter, `no-store`; `MessageSearchQuery` and `MessageSearchPage` (`shared/messageSearch.ts`); 429 past
two running.

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
  backup requests, and module and CharX imports also answer 503 with `Retry-After`; a typed store-closed error maps to
  the same retryable response.
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
memory, `overlaysMemoryProjection`, adds the chats' `memory_events`) are `readRefsWithinBudget`'s comment. A `chatRows`
entry (one group, charged its rows and stored metadata) answers its rows and named fields as stored (no projection) at
exactly its revision, else `moved` with the current one (null: gone), never `unanswered`.

### Chat summaries

- `chatSummary` (`chatStore.ts`), over the stored `chatSummaries.text`, answers the full summary listing, collection
  summary reads, and single-chat binding reads; a feed chat entry's `summary` has the same fields (`summaryWithTime`); a
  fresh projection is read without `meta` ([Summary projection](#summary-projection)).
- Summaries include optional `lastMessageAt`: the finite numeric `time` of the last message by position, absent for an
  empty chat or an undated final message. Its memo, invalidating writes, and transaction rule are the comment on
  `lastMessageTimes` in `createChatTables`.

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
- By-id writes read touched rows by id (`TOUCHED_ROWS_SQL`) and counts from the `messageCounts` memo, not `COUNT(*)`.
- Reroll snapshots (`scriptstateCheckpoint`, candidates' `scriptstateAfter`) follow position: after an `append` only the
  newest non-comment message or a live job's row keeps them; `setMessage`/`patchMessage` cannot restore them on a row
  holding none unless an admitted generation or the lock owner writes (`candidateRows` reports `cleared`).

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
`data/exportScrub/` worker removes `llmSecrets` from the export's copy; the import validates the whole archive, its
database in a restore queue turn, then installs under maintenance by the
[content-name rule](#backup-and-import-internals).

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

### Shutdown during a restore

Shutdown aborts a restore before its install (`restoreShutdown` in `app.ts`; `restoreSignal`'s comment in
`routes/backups.ts` has where it is checked), answering 503 with its staging removed. An upstream commit stops the same
way (`staging.signal`). A version-2 import admitted before shutdown finishes, and `dispose` waits for it.

### Upstream backups

- Upstream `.bin` import and export use prepare/commit or prepare/download flows. Conversion runs in a worker with a
  heap cap; staged work expires after ten minutes. `RISU_MAX_UPSTREAM_DB_BYTES` caps the decoded database.
- The prepare's worker stages from its build store with `stageValidatedSnapshot`, on the default kinds
  (`importStage.ts`).
- Import reports changes for review; the commit's recheck, its 412 and `409 changedSinceReview`, and when the import is
  handed back are the comment above the commit route.
- Export reads the snapshot without checkpoint tables, so upstream saves hold no named checkpoint history. A failed
  memory walk does not stop it ([projection](structured-memory/projection.md#the-hypav3-projection)).

### File imports

`.risum`, CharX, and Realm imports validate before publishing assets. Module and CharX uploads spool to disk; once their
NDJSON response starts, failures are returned as a final error line. Realm import stages card contents before the tab
commits its assets, and shares one import slot with module and CharX imports.

### Maintenance

Maintenance closes new resource and storage mutations and waits for admitted writes. Restore and backup imports use the
maintenance gate; the asset sweep uses only `exclusive`. Jobs, transforms, and memory tasks stop for it
([job state](server-generation.md#process-memory)).

## State

Paths are under `save/` ([Disk layout](self-host-server.md#disk-layout)). `backups/` holds the resource snapshots
(`resources-*.sqlite`, single files, newest 20 unpinned plus pinned ones, `pins.json`); assets are not in snapshots, and
the [asset ledger](self-host-server.md#asset-mark) indexes each one's references once.

### Store tables

`data/resources.sqlite` (plus `-wal` and `-shm`) is the resource store. `PRAGMA user_version` is the store version (3:
settings sections and collections, no `root` record; tables as in version 2).

- `resources` (`seq` autoincrement, `kind`, `id`, `revision`, `schemaVersion`, `data` JSON text, unique `(kind, id)`).
- `meta` holds the random `epoch`, `summaryProjectionVersion`, and `normalizationStamp`.
- `chats` (`seq`, `characterId`, `id`, `revision`, `schemaVersion`, `meta` JSON).
- `data/chatStore.ts` `searchNextCharacterChat`, the per-character newest-first walk, must write `+characterId`, so
  SQLite walks the rowid instead of sorting the `UNIQUE (characterId, id)` matches. `IF NOT EXISTS` can add a
  `(characterId, seq)` index: the layout check reads only tables, by name.
- `messages` (`chatSeq`, message `id`, integer `position`, `data` JSON, and the generation fence: `generationId`,
  `generationSeq`, `generationFinal`, `generationHistory` of up to 8 earlier ids).
- `openChatSchema` adds, when missing, `messages_role` on `(chatSeq, json_extract(data, '$.role'))`, which counts user
  turns reading no row and refuses a non-JSON `data`, and `messages_checkpoints`, partial on the checkpoint keys' text,
  so append cleanup reads only rows holding one. An older file's first open reads every row once.
- `chatOrders` (`characterId`, `seq`, `revision`, `ids` JSON).
- `changes` (`cursor` autoincrement, `kind`, `characterId`, `id`, `revision`): transactional refs/tombstones; order ids
  are character ids. Created at open beside `openChatSchema`, outside `STORE_TABLES_SQL` and the layout check; no
  version bump. Open-time writes bypass it.
- The log prunes to 20,000 rows by cursor range (cursors are contiguous); deletes do not shrink the file. `replaceAll`
  empties it, keeping the sequence. Whole-file snapshots and backups contain it; restore ignores it.
- `chatGroups` (`seq` autoincrement, `chatSeq` referencing `chats.seq` with `ON DELETE CASCADE`, `groupId`, `revision`,
  `result` JSON, unique `(chatSeq, groupId)`), created when missing at open, outside the layout check: never restored, a
  restore leaves it empty (deleting the chats cascades).
- The `memory_*` tables are created the same way, but a restore carries them as an optional group, like the
  [checkpoint tables](#checkpoint-tables) ([structured memory](structured-memory/records.md#memory-tables)).

### Summary projection

- `chatSummaries` (`chatSeq` primary key referencing `chats.seq` with `ON DELETE CASCADE`, `revision`, `text`) is each
  chat's summary projection (`summaryText`: the listed metadata fields as JSON, without `lastMessageAt` or the
  revision), created the same way and outside the layout check: `backupTo` copies it into every snapshot, validation
  ignores it, and a restore writes its own rows.
- `writeChatMeta` is the only live writer of `chats.meta` and stores the projection in the same transaction (a
  [restore's writers](#invariants) write both tables together); every other chat write moves the row's `revision` with a
  compare-and-set, so a row an older server left behind never turns fresh. A row is fresh when its `revision` equals the
  chat's.
- `openChatSchema` runs in its own transaction after the normalization pass and before any chat statement is prepared:
  it rebuilds missing and stale rows, and every row when `summaryProjectionVersion` differs from
  `SUMMARY_PROJECTION_VERSION` (bump it when the shape changes). A `meta` that cannot be projected rolls that
  transaction back and closes the store, stopping the open.
- A reader that finds a stale or missing row computes it from `meta` and rewrites it outside a transaction, best-effort,
  as neither a store write nor a feed event; inside a transaction it answers the computed text and writes nothing.

### Checkpoint tables

The checkpoint tables are created the same way and outside the required layout (a snapshot without them is valid), but a
snapshot with any of them has them checked and restored (`walkCheckpointSnapshot`). The memory tables share its layout
check, `snapshotTableGroup`.

- `chatCheckpoints` (`seq` autoincrement, `chatSeq` referencing `chats.seq` with `ON DELETE CASCADE`, `id`, `kind`
  (`manual`, `auto`, `safety`), `name`, `createdAt`, `revision`, `chatRevision`, `userTurns`, `messageCount`, `preview`
  JSON, `pages` JSON (the ordered message page hashes), `fields` JSON (captured field → page hash, plus
  [the memory manifest](structured-memory/lifecycle.md#a-checkpoint)), unique `(chatSeq, id)`).
- `checkpointPages` (`hash` primary key, `text`).
- `checkpointPageRefs` (`checkpointSeq` referencing `chatCheckpoints.seq` with `ON DELETE CASCADE`, `hash`, indexed).
- `chatCheckpointPolicy` (`chatSeq` primary key referencing `chats.seq` with `ON DELETE CASCADE`, `autoEvery`,
  `autoKeep`, `lastAutoTurns`).
- A checkpoint delete or prune removes the pages its own checkpoints freed, in the caller's transaction, and scans
  nothing else; the table-wide sweep runs at open, and a restore keeps only the snapshot's referenced pages, so a
  deleted chat's or character's pages wait for the next open.

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
- The chat source generations, the `onChatInvalidated` listeners (one entry per chat deleted or replaced whole since the
  open or the last restore; a restart starts them over), and the `onMessagesChanged` listeners.

## Coupling

- [Self-host server](self-host-server.md): [Routes](self-host-server.md#routes),
  [Rate limits](self-host-server.md#rate-limits), [Request bodies](self-host-server.md#request-bodies), and its
  [Invariants](self-host-server.md#invariants) for file publication and the one-process rule.
- [Live-update feed](live-update-feed.md#publication-budget): the store publishes each commit to it.
  [Server generation](server-generation.md): jobs write through the store under its
  [token rule](server-generation.md#invariants), and `onChatInvalidated` has one production listener,
  `memoryTasks.invalidate` (`app.ts`). The transform loader does not subscribe: `prompt/displayScope.ts` keys its
  transcript cache by `chatSourceGeneration`.
- [Resource sync](resource-sync.md) and [backup-sync-hub](backup-sync-hub.md) hold the client side.

## Invariants

- Mutations carry the current resource epoch; stale epochs fail without writing. Resource revisions, chat groups,
  restore floors, generation write fences, and optimistic recovery are detailed in
  [chat store](chat-store.md#restore-floor). The resource store publishes a change only after commit
  ([Publication budget](live-update-feed.md#publication-budget)).
- Restore and import install under maintenance, after a safety snapshot, with reads open. The store replaces its
  resource state atomically, in one transaction: a rollback leaves rows, epoch, write count, memos, and the feed as they
  were, and a commit makes every earlier token stale and publishes one `epoch` event.
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
  archives pick it up. Add the kind name to `RESOURCE_KIND` in `shared/resources.ts` for the client.
- Change the archive format: `server/src/data/archive.ts`, `planImport` and the export in `routes/backups.ts`,
  `BackupArchiveManifest`, and the client reader in `src/ts/drive/backuplocal.ts`; bump the manifest version.
- Add a table a restore carries: its DDL in one of the schema strings a staged store shares with the live store
  (`STORE_TABLES_SQL`, `CHAT_OPEN_SCHEMA_SQL`, `CHECKPOINT_SCHEMA_SQL`), its checks in the walk (`walkSnapshotFile`),
  its row in the sinks (the staged writer's, and `readSnapshotFile`'s when a reader uses it), and its copy in the
  install (`copyStagedChats`, `copyStagedMemory`, `copyStagedCheckpoints`, or `replaceAll`), through a seq map when it
  references a seq.

## Tests

The in-process harness and the slow table are in the [shell's Tests](self-host-server.md#tests).

- `restore.runner` replaces what stages a restore, and `upstreamImport.runner` runs an upstream prepare in process.
- In `backups.test.ts`, export admission is `snapshots.exclusive`; staged-directory visibility alone does not prove it
  has entered the queue.
- Store, chats, and checkpoints:
  `pnpm --silent test:agent server/src/tests/{resourceStore,chatStore,chatCheckpoints,chatCheckpointRoutes,sqliteSynchronous}.test.ts`.
- Routes:
  `pnpm --silent test:agent server/src/tests/resources server/src/tests/{resourceCompression,messageSearch}.test.ts`.
- Snapshots, archives, and imports:
  `pnpm --silent test:agent server/src/tests/{snapshots,backups,importModule,importCharx,importRealm}.test.ts server/src/tests/upstream`.

## Known Hazards

### Issues

- `normalizeCharacterOrder` and `normalizeCustomModels` do not deduplicate entries. The former accepts folder objects
  without validating their fields; the latter requires string `id` and `internalId` and strips retired credential
  fields.

### Limitations

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
  with the store and the longest chat ([measured](../audit/server-measurements-2026-11-01.md)). Decision: Server Byte
  Budgets D5, archive.
- The restore worker's and the upstream workers' heap limits (`RISU_RESTORE_HEAP_MB`, `RISU_UPSTREAM_IMPORT_HEAP_MB`,
  `RISU_UPSTREAM_EXPORT_HEAP_MB`) bound the V8 heap only, not Buffers or SQLite memory, and an inherited
  `--max-old-space-size` overrides them.
- One row far larger than that limit can abort the whole process instead of ending the worker
  ([observed](../audit/server-measurements-2026-11-01.md)): the store and epoch stay as they were, and the next start
  empties the staging. At the default 2048 no row the 100 MiB request cap admits reaches it; a much lower limit can.
  Decision: a ceiling against a runaway file, not process isolation (`server/src/data/restore/validateRunner.ts` header;
  V8-only scope, Server Byte Budgets D5, archive).
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
- The change log is bounded by rows, not bytes ([Store tables](#store-tables)): ids may be 512 UTF-16 units, so 20,000
  rows made an 82 MB database in a 2026-11-05 probe (a few MB with UUID ids), and the `DELETE` prune never shrinks the
  file. Every kept snapshot (20, plus up to 20 pinned) and backup carries it, so size snapshot storage as rows × id
  length. Decision: Found Issues Clearance Q4 (owner, 2026-11-09): a byte bound costs a `SUM(length(id))` per prune, and
  a VACUUM would stall every commit.
- A version-2 export (`server/src/routes/backups.ts`) opens a custom-key asset while it streams without
  `claimAssetKey`'s lock, so a custom-key write (`server/src/routes/storage.ts`) during the export can pair the
  archive's database copy with later bytes; content-hash keys cannot change. Decision: Found Issues Clearance Q5 (owner,
  2026-11-09): custom keys are mutable by contract, and holding the lock across a stream would block the writer.

### Gotchas

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
