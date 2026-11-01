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

### Store and chats

- `data/resourceStore.ts`, `chatStore.ts`, `kinds.ts`, `normalize/`, `snapshots.ts`, `archive.ts`, `checkpointStore.ts`,
  and `checkpointService.ts` own the database and its disk lifecycle. The store publishes on the
  [feed](server-generation.md#coalescing-and-publish-order).

### Backup and import internals

- `data/restore/` validates a restore's database in a worker and writes its staged store ([Validation](#validation));
  `data/upstream/` reads and writes RisuAI-compatible `.bin` saves in workers (`risuSave.ts` is the codec).
- `http/spool.ts`, `fileImport.ts`, `contentAsset.ts`, `recordStream.ts`, and
  `routes/{backups,backupsUpstream,backupsUpstreamExport,importModule,importCharx,importPng,importRealm}.ts` handle
  archive and card file transfer.
- A content-named asset (`assets/<sha256 hex>.<ext>`) that already exists is kept only when it holds its bytes
  (`holdsVerifiedAsset` in `http/assetVerification.ts`, a recorded verification of the same file included): the module,
  CharX, PNG, and Realm imports replace an empty, truncated, or wrong file by rename, and an archive restore
  (`backups.ts` `restoreValidated`) replaces it when the archive's copy hashes to the name. Other existing names are
  never overwritten by a restore.

### Resource routes

`routes/resources.ts`, `resourceBoot.ts`: `checkAuth` (JWT), authenticated limiter. Writes need the
[epoch](#epoch-and-response-rules); reads, `POST` reads included, do not. A reverse proxy must keep the encoded ids
([Gotchas](self-host-server.md#gotchas)).

- `GET /api/resources?kinds=a,b[&chats=1|&chatSummaries=1]`:
  `{ epoch, kinds: { <kind>: [{ id, revision, data }] }, chats?, chatSummaries?, chatOrders? }`, one committed state,
  compressed per `Accept-Encoding` (`compressedJson`); 400 for an unknown or missing kind, or for both chat options.
- `POST /api/resources/read`: body
  `{ refs?, chats?: [{ characterId, id }], chatCollections?: [characterId], chatSummaryCollections?: [characterId], continue?: boolean }`
  (1-5000 in all, each answered once; capped at 32 MiB after authentication, the largest valid request being about 15.4
  million bytes); `{ epoch, items, chats?, chatCollections?, chatSummaryCollections?, unanswered? }` (null for a missing
  record or chat; summaries: no messages, memory, bookmarks, or `toolCalls`; see the [read budget](#read-budget)).
- `POST /api/resources/boot`: body `ResourceBootRequest`
  `{ kinds, chatSummaries?: true, known?: { records?, items?, chatCollections? } }` (own 2 MiB cap, 413 past it; 400 for
  a malformed entry, an unknown kind, or over 5000 claims); `ResourceBootResult`
  `{ format: 1, epoch, kinds, chatSummaries?, chatOrders?, chatSummaryFormat?, cachedChatCollections? }` with `cached`
  and `items` records (`resourceBoot.ts`), compressed per `Accept-Encoding`.
- `POST /api/resources/batch`, + epoch: body `{ ops?, chats?, chatOrders? }` (1-5000 operations, nested chat ops
  counted; a resource op has exactly one of `data`, `delete`, and `patch`); `{ epoch, results, chats?, chatOrders? }`;
  409 `{ error, conflicts }` with nothing applied.
- `GET /api/resources/revisions`:
  `{ epoch, resources: [{ kind, id, revision }], chats: [{ characterId, id, revision }], chatOrders: [{ characterId, revision }] }`,
  no data (the live-update reconcile); compressed per `Accept-Encoding` (`compressedJson`).
- `GET /api/resources/:kind`: `{ epoch, items: [{ id, revision, data }] }` in creation order; 404 for an unknown kind.
- `GET /api/resources/:kind/:id`: `{ epoch, revision, data }`; 404 when missing, 400 for an invalid id.
- `PUT /api/resources/:kind/:id`, + epoch: body `{ baseRevision: string | null, data }`; `{ epoch, revision, data }` as
  stored; 409 `{ error, revision }` on a stale revision.
- `DELETE /api/resources/:kind/:id`, + epoch: `?baseRevision=<token>`; `{ success: true, epoch }`; 409
  `{ error, revision }` when stale or already gone; 400 for a singleton.

### Credential routes

`routes/llmSecrets.ts`: JWT + epoch, authenticated limiter.

- `PUT /api/llm-secrets/<path>`: body `{ value, baseRevision }`; sets one credential; `{ epoch, revision, data }` with
  the masked record; 400, 409 `{ error, revision }`, 412, 503.
- `DELETE /api/llm-secrets/<path>?baseRevision=`: clears one credential; answers as the PUT.

### Message search route

- `POST /api/chats/search` (`routes/messageSearch.ts`): `checkAuth`, authenticated limiter. Body `MessageSearchQuery`
  (`shared/messageSearch.ts`, capped at 4 KiB of received bytes after authentication); `MessageSearchPage`, `no-store`;
  404 named character/chat missing, 409 `reason: "epoch"`, 429 past two running, 503 maintenance.

### Chat checkpoint routes

`routes/chatCheckpoints.ts`: JWT, authenticated limiter, `no-store`. Writes also need the epoch, cap their body at 16
KiB after authentication, and answer 400/404/412/413/503 besides what their bullet names.

- `GET /api/chat-checkpoints?characterId=&chatId=`: `{ epoch, checkpoints }`, newest first; 400/404.
- `GET /api/chat-checkpoints/policy?characterId=&chatId=`: 200 `{ epoch, policy: { autoEvery, autoKeep } | null }`;
  400/404.
- `PUT /api/chat-checkpoints/policy`: `{ characterId, chatId, autoEvery, autoKeep }` or
  `{ characterId, chatId, off: true }` → 200 `{ epoch, policy: { autoEvery, autoKeep } | null }`.
- `POST /api/chat-checkpoints/save`: `{ characterId, chatId, name }` → `{ epoch, checkpoint }`; captures server state;
  409 `generating`.
- `POST /api/chat-checkpoints/rename`: `{ characterId, chatId, id, baseRevision, name }` → `{ epoch, checkpoint }`; 409
  with current `revision`.
- `POST /api/chat-checkpoints/delete`: `{ characterId, chatId, id, baseRevision }` → `{ epoch, ok: true }`; 409 with
  current `revision`.
- `POST /api/chat-checkpoints/load`: `{ characterId, chatId, id, chatBaseRevision }` →
  `{ epoch, chatRevision, safety }`; atomic replacement with safety summary; 409 (current `revision` or
  `reason: "generating"`).

### Backup routes

`routes/backups.ts`: `checkAuth`, authenticated limiter. The epoch applies only where a bullet says + epoch.

- `GET /api/backups`: `{ items: [{ id, createdAt, size }] }`, newest first.
- `POST /api/backups/:id/restore`, + epoch: validated in a worker, then replaces every resource (safety snapshot first);
  `{ epoch }`; 404 unknown id, 400 invalid snapshot, 503. It never reads its body
  ([Limitations](self-host-server.md#limitations)).
- `POST /api/backups/export`: body `{ partial?: true | string[] }` (`true`: profile assets selected from the archived
  snapshot; list: explicit asset keys); streams an archive ([export and import](#archive-export-and-import)); 400 for
  invalid input or too many partial assets, 413 when it cannot fit the format.
- `POST /api/backups/import`, + epoch: raw archive body (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`, default 16 GiB);
  `{ epoch, assetsWritten, assetsSkipped }`; 400/413.

### Upstream backup routes

`routes/backupsUpstream.ts`, `backupsUpstreamExport.ts`: `checkAuth`, authenticated limiter.

- `POST /api/backups/import-upstream/prepare`, + epoch: raw upstream RisuAI `.bin` body (no 100 MiB limit;
  `RISU_MAX_IMPORT_BYTES`): converted in a worker into a staged store, nothing replaced; NDJSON
  (`shared/upstreamBackup.ts`): `{ phase, done, total }` lines, then `{ token, report }`, or `{ error }`; 400 (a refused
  archive, a Risu Account backup's message among them), 409 (busy, or
  `Another RisuAI backup import is waiting for its answer`), 412, 413, 503.
- `POST /api/backups/import-upstream/commit`, + epoch: `{ token, acceptWrites? }`: replaces every resource with the
  staged store (safety snapshot first); `{ epoch, assetsWritten, assetsSkipped, selection }`; 404 `Import expired`, 409
  busy or `{ error: "changedSinceReview", writes }`, 412, 400 (invalid body or staged store), 503 (the import kept on
  409/412/503).
- `POST /api/backups/import-upstream/cancel`: `{ token }`: removes the prepared import; 204 whether it still waited or
  not; 400.
- `POST /api/backups/export-upstream/prepare`:
  `{ promptPresetId, modelPresetId, personaId, includeSecrets, selectedChat? }`: projects one copy of the store into a
  RisuAI `database.risudat` in a worker and keeps it under a token; `{ token, report }`
  (`shared/upstreamExportReport.ts`); 400 invalid body, 409
  `Other RisuAI-compatible backups are waiting for their download`, 413 when it cannot fit the archive format, 503
  during shutdown.
- `GET /api/backups/export-upstream/download`: `?token=`: uses the token up and streams the referenced assets as
  basename records, then `database.risudat`; 400 malformed token, 404 `Export expired`.
- `POST /api/backups/export-upstream/cancel`: `{ token }`: removes the prepared export; 204 whether it still waited or
  not; 400.

### File import routes

`routes/importModule.ts`, `importCharx.ts`, `importRealm.ts`: `checkAuth`, authenticated limiter, no epoch. The Realm
routes cap their bodies at 4 KiB.

- `POST /api/import/module`: raw `.risum` body (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`); NDJSON
  (`shared/moduleImport.ts`): `{ done, total }` lines, then `{ module, assetsWritten, assetsSkipped }` with each stored
  key in `module.assets[i][1]`, or `{ error }`; 400/409/413, 503 `Retry-After: 5`.
- `POST /api/import/charx`: raw CharX body, a zip or a `charxJpeg` (no 100 MiB limit; `RISU_MAX_IMPORT_BYTES`); NDJSON
  (`shared/charxImport.ts`): `{ done, total }` lines, then `{ card, moduleData, assets, excluded }` (`moduleData`
  base64, `assets` entry name → stored key), or `{ error }`; 400/409/413, 503 `Retry-After: 5`.
- `POST /api/import/realm`: `{ id }`: the server downloads, validates, and stages the Realm card, writing nothing;
  NDJSON (`shared/realmImport.ts`): one `{ kind: "charx" | "png", token, card, ... }` or `{ kind: "json", body }` line,
  or `{ error }`; 400/409 (busy, or `Too many imports are waiting`)/413, 502 (Realm's text or
  `Realm download failed`), 503.
- `POST /api/import/realm/commit`: `{ token }`: stores the staged card's assets; NDJSON: `{ done, total }` lines, then
  `{ kind: "charx", assets, excluded }` or `{ kind: "png", image, assets }`, or `{ error }`; 400, 404 `Import expired`,
  409, 413, 503 (the staged import kept on 409/503).
- `POST /api/import/realm/cancel`: `{ token }`: removes the staged card; 204 whether it still waited or not; 400,
  413, 503.

## Flows

### Epoch and response rules

- "+ epoch" means the `x-resource-epoch` header must name the current database epoch (412
  `{ error: "EpochMismatch", epoch }` otherwise).
- Mutations answer 503 with `Retry-After` while a restore or an import runs. During shutdown, new resource requests
  (including reads), backup requests, and module and CharX imports also answer 503 with `Retry-After`; a typed
  store-closed error maps to the same retryable response.
- Every `/api/resources` and `/api/llm-secrets` response is `Cache-Control: no-store`. Every read route
  (`/api/resources?kinds=`, `/api/resources/read`, `/api/resources/:kind`, `/api/resources/:kind/:id`) and the PUT
  response answer a kind with `project` in its projected form: `llmSecrets` is masked.
- Every whole chat a read returns (`/api/resources/read` `chats` and `chatCollections`, `/api/resources?chats=1`)
  carries `streaming`: the chat's generation locks as the live-update `hello` lists them (`ChatReadRecord`,
  `shared/resources.ts`), taken from `generationJobs.streamingSnapshot()` in the same synchronous step as the store
  read, so the lock list matches the chat's revision (`[]`: no locks; a missing chat and a summary carry none).
- The tab replaces the chat's feed locks with it ([feed locks](resource-sync.md#feed-locks)); a client must treat the
  field as optional.

### Read budget

`POST /api/resources/read` deduplicates `refs` by kind and id, `chats` by character and id, and the two collection lists
by character, always. With `continue: true` (`registerResourceRoutes` `readResponseBytes`, default
`MAX_READ_RESPONSE_BYTES` in `shared/resources.ts`, 16 MiB; `resourceStore.readRefsWithinBudget`) one answer is bounded
by its charged bytes, and without it the answer is whole, so an older tab that takes an absent entry for a deleted one
never meets `unanswered`.

- A group is a character record with its `chatCollections` and `chatSummaryCollections` entries; every chat entry and
  every other ref is a group of one. Groups go in request order (`refs`, `chats`, `chatCollections`,
  `chatSummaryCollections`, each at its first mention); the first that would pass the budget and every group after it
  are named in `unanswered`, in the request's shapes, uncharged past that one and unread.
- The charge is stored bytes from SQL before anything is parsed, not wire bytes: a record's `octet_length(data)`; a
  chat's `meta` plus its message rows, two queries; a collection's order text plus one aggregate over its chats and one
  over their messages; a summary collection's order text plus its `chatSummaries` rows as stored.
- The budget is soft: an answer's first group is served whatever its size, so a chat or a collection that outgrew it
  stays readable, and a chat or a collection is never split. Internal `readRefs` callers are unbudgeted. A character's
  group is read in one synchronous step; rounds are not one snapshot.

### Chat summaries

- `data/chatStore.ts` `chatSummary` over the stored `chatSummaries.text` is shared by the full summary listing,
  collection summary reads, single-chat binding reads, and a feed chat entry's `summary`; none of them selects or parses
  `meta` ([Summary projection](#summary-projection)).
- Summaries include optional `lastMessageAt`: the finite numeric `time` of the last message by position, absent for an
  empty chat or an undated final message. `createChatTables` memoizes both values and absence by chat seq; misses read
  one row through `messages_position` (`ORDER BY position DESC LIMIT 1`), never MAX(time) or an earlier dated message.
- Message creation/replacement, append/insert, setMessage, setText, patchMessage, removal, and translation writes
  invalidate it, as do chat and character cascade deletion; `replaceAll` clears the memo once it committed. While
  `db.isTransaction`, reads query directly and neither read nor fill the memo, so a throwing transaction callback cannot
  leave rolled-back activity cached. Metadata-only writes keep the memo.

### Chat activity

Ordinary send, continue, reroll, and group jobs write chat activity without changing the character or group resource
revision; explicit character effects (memory enable, triggers, Lua setters) still write it. Streamed continue refreshes
the continued message's time in its existing final write; non-streamed continue sets its time when writing the reply.
Preview and previewPrompt change neither activity nor character revision. The stored `lastInteraction` remains a frozen
legacy fallback; the client derives last-chatted ordering from chats ([chat store](chat-store.md#last-chatted)).
Upstream export keeps its independent cold-storage rule: raise a numeric legacy value to the newest chat `lastDate`, but
leave absence as absence (upstream reads it as now).

### Chat writes and checkpoints

- The client save adapter batches resource, chat, and order changes through `/api/resources/batch`; conflicts roll the
  batch back.
- Group ids: a chat group whose id its chat incarnation remembers returns its earlier result without applying again or
  publishing a chat feed ref. Duplicate tracking stays internal; the HTTP response shape is unchanged. A newly applied
  group publishes its chat ref as usual.
- [Own chat changes](server-generation.md#own-chat-changes) and [feed entries](server-generation.md#feed-chat-entries)
  stay out of the HTTP results.
- The server-specific checkpoints live in `checkpointService.ts`: a load checks the current chat and generation locks,
  takes a safety checkpoint, applies the replacement transactionally, sets the restore floor, and invalidates retained
  memory-task input.
- Automatic checkpoints run only after a job ends with a final `done`, when the chat policy's user-turn threshold is
  met; the count comes from the `messages_role` index (`countUserTurns`), so a turn that is not due reads no message
  row. A save takes its two counts from SQL, parses the last two rows for the preview and the metadata once for the
  field pages, and otherwise only selects and hashes the stored row texts.

### Snapshots and restore

- The snapshot timer runs every ten minutes and writes only after committed resource changes; it retains the newest 20
  snapshots.
- A restore checks the epoch and takes a turn of a FIFO queue (`routes/backups.ts`), which spans its validation and
  install: one validation worker runs at a time, a second restore waits, and a stale waiter answers 412 with no work and
  no safety snapshot.
- The turn pins the snapshot into a staging folder (`snapshots.pin`, under the snapshot lock: a hard link, or a copy on
  `EXDEV` or `EPERM`, so retention cannot take the file; a snapshot not listed is a 404), [validates](#validation) it
  outside maintenance, verifies the staged file, then under maintenance checks the epoch, makes a safety snapshot, and
  [installs](#install), advancing the epoch. A client that leaves does not cancel a restore.

### Archive export and import

The version-2 archive export streams a database snapshot and asset records; its exported database omits `llmSecrets`.
Import authenticates and checks the epoch before reading, spools the full archive and validates it, its database in a
turn of the same queue that ends before maintenance, then installs it under maintenance with a safety snapshot, adding
missing asset files and repairing damaged ones under the [content-name rule](#backup-and-import-internals).

### Validation

- `data/restore/stageValidatedSnapshot.ts`: `walkSnapshotFile` reads the source one row at a time and runs every check,
  handing each checked row to a sink; `readSnapshotFile` collects them in memory for the upstream export, and the
  restore's sink, the raw validated-row writer (`writeValidatedStore`), writes them into a new file created exclusively,
  with the live schema, a rollback journal in memory, and no fsync.
- Numeric revisions stay as stored, chats and checkpoints keep their source `seq`, positions are compacted to `0..n-1`,
  fences and checkpoint pages stay byte for byte, refs come from the manifests, projections from the normalized
  metadata; retired kinds, the source's `meta` rows, its summaries, `chatGroups`, and `chatRestoreFloors` stay out, and
  no singleton is materialized.
- What stays in memory is the largest row or page and the id sets of the cross-row checks. Every page goes into the
  staged table as it is read, and the unreferenced ones are deleted at the end.
- `validateRunner.ts` runs this in one `worker_threads` thread per restore on the default kinds, under
  `RISU_RESTORE_HEAP_MB` (default 2048); a context with `resourceKinds` runs it in process, and `restore.runner`
  replaces both. A refusal keeps its text (400), an out-of-memory end or an exit before the report is a 400 saying so,
  and an unexpected failure is logged and a 500. The closed file is reported by size, mtime, inode, and SHA-256.

### Install

- `verifyStagedFile` re-checks that report on the serving thread (a regular file by `lstat`, then SHA-256 in 1 MiB
  chunks that yield between them; a mismatch is a 400).
- `replaceAll(stagedFile, report)` then stats the file again and reads its version and layout on a short read-only
  connection, attaches it (`mode=ro&immutable=1`), and in one `BEGIN IMMEDIATE` deletes the live rows and copies the
  staged ones with `INSERT ... SELECT` in dependency order: fresh live seqs through temporary maps, so the
  `AUTOINCREMENT` high-water marks keep moving and `sqlite_sequence` is never copied, with foreign keys on.
- It creates the missing `materialize` singletons, sets the epoch, writes or removes the stamp, and commits; no record
  normalizer runs on an existing row, since validation normalized its rows. `DETACH` runs outside the transaction, and a
  failed one is logged and detached by the next install. The memos, the source generation base, and the `epoch` event
  change only after the commit, so a rollback leaves them.

### Shutdown during a restore

Shutdown aborts a restore before its install (`restoreShutdown` in `app.ts`, `restoreSignal` in `routes/backups.ts`):
its worker is terminated, a waiter ends at its turn, and it answers 503 with its staging removed. The signal is checked
at the turn, through the hash pass, before maintenance, inside it, and right before `replaceAll`; an install past that
check completes. An upstream commit stops the same way (`staging.signal`). A version-2 import admitted before shutdown
finishes, its worker included, and `dispose` waits for it.

### Upstream backups

- Upstream `.bin` import and export use prepare/commit or prepare/download flows. Conversion runs in a worker with a
  heap cap; staged work expires after ten minutes. `RISU_MAX_UPSTREAM_DB_BYTES` caps the decoded database.
- The prepare's worker keeps its build store (the converter's hand-off needs the store's singletons and orders), closes
  it, and stages from it with `stageValidatedSnapshot`, on the default kinds.
- Import reports changes for review and checks that the live store has not changed before commit. The commit reads no
  row: it takes the import, verifies the staged file, and checks the epoch and the accepted write count again right
  before maintenance (the hash pass is a new window); a change answers 412 or `409 changedSinceReview` and hands the
  import back with a fresh TTL.
- Export reads the snapshot without checkpoint tables, so upstream saves do not include named checkpoint history.

### File imports

`.risum`, CharX, and Realm imports validate before publishing assets. Module and CharX uploads spool to disk; once their
NDJSON response starts, failures are returned as a final error line. Realm import stages card contents before the tab
commits its assets, and shares one import slot with module and CharX imports.

### Maintenance

Maintenance closes new resource and storage mutations and waits for admitted writes. Restore and backup imports use the
maintenance gate. Jobs, transforms, and memory tasks stop for it ([job state](server-generation.md#process-memory)).

## State

Paths are under `save/` ([Disk layout](self-host-server.md#disk-layout)). `backups/` holds the resource snapshots
(`resources-*.sqlite`, single files, newest 20); assets are not in snapshots.

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
- The index `messages_role` on `(chatSeq, json_extract(data, '$.role'))` counts a chat's user turns without reading a
  row; `openChatSchema` creates it when missing, parsing every message row once on an older file's first open; it makes
  SQLite refuse a non-JSON `data`.
- `chatOrders` (`characterId`, `seq`, `revision`, `ids` JSON).
- `chatGroups` (`seq` autoincrement, `chatSeq` referencing `chats.seq` with `ON DELETE CASCADE`, `groupId`, `revision`,
  `result` JSON, unique `(chatSeq, groupId)`), which `openChatSchema` creates when missing, with no version change. It
  is outside the layout check, a snapshot's copy is not restored, and a restore leaves it empty (deleting the chats
  cascades).
- The `memory_*` tables are created and restored the same way ([structured memory](structured-memory.md#memory-tables)).

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
snapshot with any of them has them checked and restored (`walkCheckpointSnapshot`).

- `chatCheckpoints` (`seq` autoincrement, `chatSeq` referencing `chats.seq` with `ON DELETE CASCADE`, `id`, `kind`
  (`manual`, `auto`, `safety`), `name`, `createdAt`, `revision`, `chatRevision`, `userTurns`, `messageCount`, `preview`
  JSON, `pages` JSON (the ordered message page hashes), `fields` JSON (captured field → page hash), unique
  `(chatSeq, id)`).
- `checkpointPages` (`hash` primary key, `text`).
- `checkpointPageRefs` (`checkpointSeq` referencing `chatCheckpoints.seq` with `ON DELETE CASCADE`, `hash`, indexed).
- `chatCheckpointPolicy` (`chatSeq` primary key referencing `chats.seq` with `ON DELETE CASCADE`, `autoEvery`,
  `autoKeep`, `lastAutoTurns`).
- A checkpoint delete or prune removes the pages its own checkpoints freed, in the caller's transaction, and scans
  nothing else; the table-wide sweep runs at open, and a restore keeps only the snapshot's referenced pages, so a
  deleted chat's or character's pages wait for the next open.

### Store open and normalization

- Opening the store runs the normalization pass in one transaction, unless it finds its own stamp: each record whose
  normalized text or schema version differs is rewritten with its revision counter advanced (same `seq` and epoch), and
  each missing `materialize` singleton is created; a stored record its normalizer rejects, or one of a newer schema
  version than its kind, stops the start.
- The pass writes `normalizationStamp` in that transaction ([Gotchas](#gotchas) has the skip). An [install](#install)
  runs no pass.
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
- The chat source generations and the `onChatInvalidated` listeners (one entry per chat deleted or replaced whole since
  the open or the last restore; a restart starts them over).

## Coupling

- [Self-host server](self-host-server.md): [Routes](self-host-server.md#routes),
  [Rate limits](self-host-server.md#rate-limits), [Request bodies](self-host-server.md#request-bodies), and its
  [Invariants](self-host-server.md#invariants) for file publication and the one-process rule.
- [Server generation](server-generation.md): the store publishes each commit to its
  [feed](server-generation.md#publication-budget), jobs write through the store under its
  [token rule](server-generation.md#invariants), and `onChatInvalidated` has one production listener,
  `memoryTasks.invalidate` (`app.ts`). The transform loader does not subscribe: `prompt/displayScope.ts` keys its
  transcript cache by `chatSourceGeneration`.
- [Resource sync](resource-sync.md) and [backup-sync-hub](backup-sync-hub.md) hold the client side.

## Invariants

- Mutations carry the current resource epoch; stale epochs fail without writing. Resource revisions, chat groups,
  restore floors, generation write fences, and optimistic recovery are detailed in
  [chat store](chat-store.md#restore-floor). The resource store publishes a change only after commit
  ([Publication budget](server-generation.md#publication-budget)).
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
  its row in the sinks (`readSnapshotFile`'s and the staged writer's), and its copy in the install (`copyStagedChats`,
  `copyStagedCheckpoints`, or `replaceAll`), through a seq map when it references a seq.

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

- Snapshots (`save/backups/`) copy `resources.sqlite`, not assets; retained snapshots can keep references to assets that
  are never deleted, so `save/assets/` can grow.
- `normalizeCharacterOrder` and `normalizeCustomModels` do not deduplicate entries. The former accepts folder objects
  without validating their fields; the latter requires string `id` and `internalId` and strips retired credential
  fields.

### Limitations

- The SQLite resource store assumes one server process and a local filesystem
  ([Invariants](self-host-server.md#invariants)). Network filesystems are unsupported. Decision: Server Byte Budgets Q1,
  archive.
- `RISU_SQLITE_SYNCHRONOUS=normal` trades the resource store's durability for its commit time: a commit no longer waits
  for an fsync of the WAL, so after a power failure or an OS crash the latest acknowledged commits may be lost, and how
  many is not a fixed window. The database stays consistent, and a process crash loses nothing. The client's draft
  journal takes a server acknowledgment as saved, so it no longer holds what a lost commit carried. Decision: Server
  Byte Budgets Q1, archive.
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
- Validation reads as it checks, so of a refused row and a later row SQLite cannot read, the refused row is the one
  reported, and a walk stops at the first refusal in reading order: a walk over the source never holds a whole table
  (`walkSnapshotFile`).
- The upstream import stages on the default kinds, as the export reads with them, so a store with custom kinds is
  supported by neither. Decision: `data/upstream/importStage.ts` and `exportStage.ts` headers.
- Upstream export holds its records, projected database, and encoded save in memory; staged exports are capped at four
  (`shared/upstreamExportReport.ts`). An asset of 4 GiB or more cannot fit an archive record
  (`server/src/data/archive.ts`) and is reported as missing. Decision: Upstream .bin Compatibility S7, archive.
- `GET /api/resources?kinds=…` (the boot-cache miss path and the boot fallback) and `GET /api/resources/:kind` answer
  whole kinds, and the read budget does not apply to them: no budget, no `unanswered`, and their cost grows with the
  data. One read must stay one committed state for the boot; a paged form needs the read budget's `unanswered` contract,
  and has no design yet.
- The [read budget](#read-budget) is soft: a chat or a collection past 16 MiB answers whole (append groups grow a chat
  with no lifetime ceiling; the 100 MiB cap is per request), a client without `continue` is answered whole, and the
  budget charges stored bytes, not wire bytes or heap. Nothing bounds how many large answers are in flight, and
  `readRefs` and `JSON.stringify` still run on the serving thread for what is served. Decision: Server Byte Budgets D2,
  D3, and Q3, archive.

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
- Normalizers are assumed to depend on code and the registry only, not on configuration or the environment. Bump
  `NORMALIZATION_VERSION` for a change to what normalization produces that git cannot see; every commit already changes
  the stamp.
- A server from before the stamp ignores it, so running one and then returning to the very commit that wrote the stamp
  skips the pass until the next commit.
