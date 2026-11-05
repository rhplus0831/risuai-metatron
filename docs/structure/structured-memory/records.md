# Structured Memory Records: Shapes, Tables, Store, Routes, Package

## Scope

- Owns the `structuredMemory` algorithm's records: their shapes and limits, the tables and store, read and edit routes,
  and the tab's client and Markdown package.
- Paths: `shared/structuredMemory.ts`, `server/src/data/memoryStore.ts`, `server/src/routes/structuredMemory.ts`,
  `server/src/prompt/memory/structured/` (the writer's files: [the writer guide](writer.md); the read path's:
  [the read path guide](read.md); `reconcile.ts`, `inherit.ts`, and `restore.ts`: [the lifecycle guide](lifecycle.md);
  `rebuild.ts`: [the rebuild guide](rebuild.md)), and `src/ts/process/structuredMemory.svelte.ts` (its receipt and panel
  parts: [the read path guide](read.md)).
- The Memory settings page selects it, ahead of the flags. Production has its [writer](writer.md), and `assemblePrompt`
  runs [the read path](read.md). The page exposes only the preset fields something reads. Its design and remaining work
  are in [the archive](../../archived-plan/README.md).
- Not here:
  - The HypaV3 projection, its seal and the tab's mirror, a plugin read's refresh, and the reset →
    [projection](projection.md).
  - The writer, the read path, the lifecycle, the rebuild, and the page tools → [the area README](README.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](../memory.md).
  - `Chat.hypaV3Data` and its write rules → [memory](../memory.md), `shared/memory.ts`.
  - The resource store's connection, epoch, and transactions → [server resources](../server-resources.md).

## Files

- `shared/structuredMemory.ts`: shared types, limits and pure rules, safe in tab and server.
  - Records and evidence: `MemoryEvent`, `MemoryPage`, `MemorySection`, `MemoryThread`, `MemoryRun`, `MemoryReceipt`,
    `MemorySource`, `MemoryAnchoredSource`, `MemoryUnanchoredSource`.
  - Writer and send shapes: `MemoryEventDraft`, `MemoryAnalysisResult`, `MemoryPageCandidate`, `MemoryManifest`,
    `MemoryManifestItem`; `memoryGrade`, `memoryThreadEnded`, `writerPaused`.
  - Limits and window: `STRUCTURED_MEMORY_ALGORITHM`, `ADOPTED_WRITER_RUN`, `STRUCTURED_MEMORY_LIMITS`,
    `CHARACTER_SECTION_SLOTS`, `MEMORY_SECTION_BUDGETS`, `ReadEntry`, `RawWindow`, `rawWindow`, `coveredMessages`,
    `memoryEventCovers`.
  - Read contracts: `STRUCTURED_MEMORY_PATH`, `MEMORY_RECORD_KINDS`, `MEMORY_RUNS_ROUND_ROWS`,
    `StructuredMemoryContentsAnswer`, `StructuredMemoryRecordAnswer`, `StructuredMemoryPackageRound`,
    `StructuredMemoryCoverageRound`, `StructuredMemoryRunsRound`, `StructuredMemoryThreadsRound`,
    `StructuredMemoryLogRun`, `StructuredMemoryHealthAnswer`.
  - Edit and lifecycle contracts: `StructuredMemoryEdit`, `StructuredMemoryEditAnswer`, `StructuredMemoryRevertAnswer`,
    `StructuredMemoryFileRecords`, `StructuredMemoryFileEntry`, `MEMORY_RESTORE_BODY_BYTES`,
    `StructuredMemoryInheritAnswer`, `StructuredMemoryRestoreAnswer`, `StructuredMemoryAdoptAnswer`,
    `StructuredMemoryDeclineAnswer`, `StructuredMemoryResetAnswer`, `StructuredMemoryAdoption`.
- `server/src/data/memoryStore.ts`: synchronous record storage; `createMemoryTables`, `MemoryChanges`, `MemoryContents`,
  `MemoryRowTexts`, `readContents`, `readRecord`, `write`, `checkMemoryRow`; `messageSourceHash` supplies
  `MemoryAnchoredSource.hash`. The projection's part: [projection](projection.md#files).
- `server/src/data/chatStore.ts`: table declarations; `MEMORY_TABLES_SQL`, `CHAT_OPEN_SCHEMA_SQL`.
- `server/src/data/resourceStore.ts`: transaction and epoch boundary; `store.memory`, `readContents`, `readRecord`,
  `write`. Other parts: [projection](projection.md#files), [checkpoints](lifecycle.md#files).
- `server/src/routes/structuredMemory.ts`: HTTP contracts and admission; `registerStructuredMemoryRoutes`, `roundOf`.
- `server/src/app.ts`: route registration and fence wiring; `registerStructuredMemoryRoutes`, `chatHeld`, `fenced`.
- `server/src/prompt/memory/structured/edits.ts`: pure edit admission and application; `parseMemoryEdit`,
  `applyPageEdit`, `applyThreadEdit`, `MemoryEditRefusal`. Repairs (`applyEventRepair`, `flagUnsupportedSections`):
  [lifecycle](lifecycle.md#files).
- `server/src/prompt/memory/structured/pages.ts`: revert rules; `revertChange`, `revertGroup`, `revertedSection`,
  `laterEventCount`. Owner: [page tools](pages.md).
- `server/src/prompt/memory/structured/writer.ts`: pause-rule re-export shared with the panel's writer line;
  `writerPaused`. Owner: [writer](writer.md).
- `src/ts/process/structuredMemory.svelte.ts`: tab route client and package renderer; `StructuredMemoryResult`,
  `readStructuredMemoryContents`, `readStructuredMemoryRecord`, `readStructuredMemoryCoverage`,
  `readStructuredMemoryRuns`, `readStructuredMemoryHealth`, `editStructuredMemory`, `buildStructuredMemoryPackage`,
  `buildStructuredMemoryLog`, `renderMemoryPage`, `renderMemoryTimeline`, `renderMemoryThreads`, `memoryPagePath`.

## Flows

### The read routes

The tab's reads reach `server/src/routes/structuredMemory.ts` through `STRUCTURED_MEMORY_PATH`. Routes authenticate,
rate-limit and check the epoch (412 `EpochMismatch`). The route header owns paths, answers, round ordering, limits and
refusals. Epoch check and store reads share one synchronous step: each round is one snapshot, and only the opaque
`revision` comparison ties separate rounds together.

- The panel reads contents (`adoption`, `rebuild`, `recordedLanguage` included) and records through
  `store.memory.readContents` and `store.memory.readRecord`. Coverage sends stored facts (`status`, `sources`,
  `keptState`, `rerecord`) for [the tab to reconcile](read.md#the-memory-panel) against its held messages; the route
  avoids a whole-chat read, which would parse every message.
- Package and [chat-file](lifecycle.md#chat-files) reads collect `/package` and `/threads` at one revision. The byte
  budget comes from `RouteLimits.memoryPackageRoundBytes` in `server/src/app.ts`, default `MAX_READ_RESPONSE_BYTES`;
  `roundOf` defines charging before body reads and the soft first-record rule. `/runs` feeds the Log; `/cost` is
  [rebuild's cost preview](rebuild.md#the-cost-preview), with no record sent.
- `readStructuredMemoryHealth` calls `POST /health` for [the badge](read.md#the-health-badge), reading live tables and
  no messages. An answer can be a prefix of the requested chats; the tab resumes from that position. The route header
  and `StructuredMemoryHealthAnswer` define the caps and positional answers.

### The edit route

The panel calls `editStructuredMemory` with the revision of its read and one `StructuredMemoryEdit`. The route header
defines the request, body cap and refusals; `parseMemoryEdit`, `applyPageEdit` and `applyThreadEdit` own admission and
the changes to stored records.

1. The route checks ids, body and edit shape, then the epoch, then the fence. From the epoch check through
   `store.memory.write` there is no await. `server/src/app.ts` supplies the fence: a queued/running task, a job or
   generation lock, or a rebuild's run, including a stopped one, refuses 409 `fenced`. A record-now job or send's gap
   run has no task; the job fence prevents [a writer's retry](writer.md#a-writer-run) of an old answer from overwriting
   a person's edit. A rebuild's fence prevents its swap from losing the edit.
2. The route reads the stored record, applies the pure edit and calls `store.memory.write` at the client's revision. A
   no-op still sends an empty change set through the revision check, so a stale edit is refused too.
3. `StructuredMemoryEditAnswer` gives the current record and the revision the next edit must name.

[Event repairs](lifecycle.md#reconciliation-and-repairs) call `applyEventRepair`, reading the stored chat in the same
step except for retract. Retraction also passes through `withUnsupportedSections` before the write.

### The revert route

The tab's `revertStructuredMemoryChange` reads the page's current revision, then calls `POST .../revert`. The route uses
the edit route's admission order and fence, so a running or stopped rebuild refuses 409 `fenced` and its swap loses no
write. The route header owns `StructuredMemoryRevertAnswer`, the cap and refusals.

The route passes the stored page to `revertChange` in `server/src/prompt/memory/structured/pages.ts`, flags restored
evidence through `flagUnsupportedSections`, then commits through `store.memory.write`. A later standing change refuses
`superseded`, so reverting goes newest first. `revertChange` and `revertGroup` define grouping and no-ops;
`revertedSection` defines which marks come back, and `laterEventCount` the notice's count. The new `revert` history
entry is read by the writer's next input.

### The restore route

`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/restore` gives an imported chat the records its file held, after the
whole shape check of `parseRestoredRecords`, and only when the chat holds no row. Its steps are in
[Chat files](lifecycle.md#chat-files).

### The Markdown package

`buildStructuredMemoryPackage` crosses the tab client and the read routes:

1. The client collects `/package` rounds, then `/threads` at that revision, through `store.memory.readContents` and
   `store.memory.readRecord`. Trash stays out of the contents' live pages and therefore out of the package.
2. The tab renders and zips the records for `downloadFile`. The builder's comment defines retries and the file set;
   `renderMemoryPage`, `renderMemoryTimeline`, `renderMemoryThreads` and `memoryPagePath` define serialization and
   ordering. `StructuredMemoryResult` defines failures and epoch handling.
3. [Package import](pages.md#the-import-route) reads those files back on the server. Metadata is authoritative; line
   counts delimit text containing headings, fences or `---`, so the reader counts lines rather than searching for a
   delimiter.

### A memory write

`store.memory.write(characterId, chatId, { epoch, baseRevision }, changes)` in `server/src/data/resourceStore.ts`
commits one declarative change set in its own synchronous transaction. After its epoch check,
`server/src/data/memoryStore.ts`'s synchronous `write` owns revision checks, validation, no-ops and write ordering; any
failure rolls back. Inherit and restore share this boundary.

The write publishes nothing: the chat's revision and the change feed stay as they were, and a real write counts toward
snapshots like a checkpoint write.

## State

- A chat's records are events, pages, and threads, with the chat's own messages as the evidence. Each writer run leaves
  a `MemoryRun`, and each recorded turn a `MemoryReceipt`.
- `MemoryEventDraft` is what the writer returns; `MemoryEvent` adds what code owns (id, sources, status, grade, repeat
  count). `MemoryRun.analysis` keeps the bounded draft before evidence checks and deduplication, so the log shows what
  the model said even when `eventId` names something else. `MemoryRun.receipt` holds what the run listed; a message's
  `generationInfo.memory` is its copy, or what the send said ([Receipts](read.md#receipts)).
- A grade is the sum of a record's axes, 0 to 9; a record without axes has none.

### Memory tables

The tables sit in `data/resources.sqlite`, keyed by the chat's incarnation `chats.seq` with `ON DELETE CASCADE`, so a
deleted and recreated chat inherits nothing. Routes still address a chat by `(characterId, chatId)`. Created when
missing, with no version change, and outside the required snapshot layout: all five are an optional group, like the
[checkpoint tables](../server-resources.md#checkpoint-tables). A snapshot from before them restores with none, a partial
group is refused, and a full one is checked and restored. [A rebuild's staged tables](rebuild.md#state) are not of the
group: no walk reads them.

- `memory_state` (`chatSeq` primary key, `revision`, `adoptionDeclined`): one revision over all of a chat's records, and
  [a person's decline](lifecycle.md#the-adoption-choice), 0 or 1. A chat has no row until its first write, and an
  existing chat with no row is at revision 0. A decline is a write, so it moves the revision and a state row never sits
  at 0, which the snapshot walk refuses.
- `adoptionDeclined` is the first column added to a table that already exists. `SCHEMA_VERSION` stays 3, since the group
  is optional. `openChatSchema` adds it inside its `BEGIN IMMEDIATE`, so concurrent and repeated starts add it once and
  every old row reads 0. `MEMORY_TABLES_SQL` has it too, because a restore's staged store runs that `CREATE` and never
  `openChatSchema`. `memoryStateLayout` takes the two-column and the three-column `memory_state` and nothing else, and
  the walk reads a two-column snapshot as 0 and refuses any value but 0 or 1.
- `memory_pages` (`type`, `title`), `memory_events` (`title`, `status`, `createdRevision`), `memory_threads` (`title`,
  `state`), `memory_runs` (`result`): each with `seq` autoincrement, `chatSeq`, `id`, and `data`, the whole record as
  stored JSON, unique `(chatSeq, id)`. Sections stay embedded in the page's row.
- `seq` is storage order, not message order; an update keeps it, because upserts never use `INSERT OR REPLACE`.
- A restore (`walkMemorySnapshot`, `createMemoryStagingSink`, `copyStagedMemory`) keeps `data` and every revision as
  stored, gives records fresh `seq`s in the source's order, and moves `chatSeq` through the staged chat seq map. The
  listed columns come from the record, never from the source's columns, which a live write can leave unequal (a title
  with a lone surrogate binds as U+FFFD and stays an escape in `data`).

## Coupling

- The persisted value `memoryAlgorithmType` is a plain string in `shared/database.ts`; `structuredMemory` selects ahead
  of the [selection chain](../memory.md#selection-in-assembleprompt) that reads the flags, which [memory](../memory.md)
  owns.
- The tables follow the [epoch rules](../server-resources.md#epoch-and-response-rules) and the snapshot walk of
  [server resources](../server-resources.md#snapshots-and-restore); the export's walk of them is
  [projection](projection.md#the-upstream-export)'s.
- The memory revision says nothing about the chat's messages. A whole-chat `replace` keeps `chats.seq`, so the rows and
  the revision survive it, and only the memory task's fence stops a writer working from the old messages
  ([memory](../memory.md)). A checkpoint load replaces the rows too ([A checkpoint](lifecycle.md#a-checkpoint)).
- The route answers are shared types because tab code never imports `server/`; each route answers with `satisfies`, so a
  store type that drifts fails `pnpm check`.
- `app.ts` admits the routes as resource handlers: tracked, refused during shutdown, and `no-store`. `ROUTE_TEMPLATES`
  in `shared/diagnostics.ts` lists each route.

## Invariants

- Server code writes the tables only through `store.memory`, synchronously, after the task's or route's fence check. The
  exceptions are a restore's staged writer and install copy, a checkpoint load's `tx.restoreMemory`, in the load's
  transaction under its writer lease, and `reconcileMessageChanges`, which holds no fence
  ([Retraction and edits](lifecycle.md#retraction-and-edits)). A rebuild writes
  [staged tables of its own](rebuild.md#a-run), and its swap is one `write`.
- A route writes a closed edit applied to the record as stored ([the edit route](#the-edit-route)), or on
  [the inherit route](lifecycle.md#copies-and-branches) the records it builds from the source chat, or on
  [the adopt route](lifecycle.md#adopting-hypav3-summaries) the events it builds from the chat's summaries, or on the
  decline route a held chat's decline. [The restore route](#the-restore-route) and
  [the import route](pages.md#the-import-route) alone write records the tab sent: for a chat with no rows, after
  `parseRestoredRecords`.
- A snapshot a live write could have left is never refused, and a crafted one is a `ResourceValidationError` (a 400),
  never a constraint failure. A record's chat has a `memory_state` row, but a state row needs no records, and an event's
  `createdRevision` is within that row's revision, without being unique or the latest.
- A memory revision is a token, `<epoch>:<chatSeq>:<revision>`, never a bare number: a chat recreated under the same ids
  restarts at 0, and only the token's `seq` tells the two apart. `readContents` and `readRecord` both answer one.
- A stale write is refused whole and retried from a fresh read, never merged by field.
- `createdRevision` is the store's: the committing revision on insert, the stored value on update, whatever the input
  held. A caller holds an opaque token, so a write takes `MemoryEventWrite`.
- No record's stored text passes `MAX_READ_RESPONSE_BYTES`. `STRUCTURED_MEMORY_LIMITS` bounds no body, so this refusal
  is what keeps a page's embedded sections within the read budget, and it is hard where the read budget is soft.
- Table-of-contents statements never select `data`; `octet_length(data)` takes the size from the row's header. Column
  values come from the serialized record, so `toJSON` cannot make a column disagree with `data`.
- The store checks what its columns and rows need, not a record's whole shape: the callers own that, and a record from
  outside passes `parseRestoredRecords`.
- A package path never holds a raw id: a resource id may hold `/`, so the id part is `encodeURIComponent` with `*` also
  encoded. It alone makes a path unique; the title part is display.
- `structuredMemory` and every value in the module's `const` lists are persisted: never rename one (repository invariant
  D5). A new value is added to its list.
- Event status is `active`, `retracted`, or `stale`. Unfinished recording lives on the run and the receipt: a failed
  first recording commits no event, and a failed re-record leaves the committed event in place until its replacement
  succeeds.
- A `MemoryAnchoredSource` hash is the SHA-256 of the stored message's role and `data`, never `generationInfo`, so a
  receipt write keeps the hash.
- A `MemoryUnanchoredSource` means the anchor was never known: an adopted summary whose message was already gone. It
  forces its event `stale` until a person keeps it. A source whose message disappears later keeps its original hash and
  index. A run's window holds only anchored sources.
- Sections carry both `provenance` (event ids) and `sources`, and a history entry's `before` carries all three of body,
  provenance, and sources, so a revert never restores a body with the replacement's evidence. `before` is `null` when
  nothing was replaced, and `heading` is `null` for a change to the whole page.
- The state after a history entry is the next entry's `before` or the live section; no `after` is stored.
- On a character page, a section's `heading` holds a `CHARACTER_SECTION_SLOTS` key, not display text. Other page types
  use free headings.
- Code owns grades: a draft carries scored axes, and only the stored `MemoryEvent` and `MemoryKnowledge` carry `grade`.

## Recipes

- A new persisted record field: add it to the shape in `shared/structuredMemory.ts`, optional unless every stored record
  will have it, give it [a check](lifecycle.md#recipes) in `structured/restore.ts`, and extend this guide's contract.
- A new closed value: append to its `const` list; a validator reads the list, so it follows.
- A new column: `CREATE TABLE IF NOT EXISTS` never extends a table, so it needs its own migration in `openChatSchema`
  and the `CREATE` too, and `MEMORY_TABLE_COLUMNS` matches exactly, so the walk must also take a snapshot of the old
  layout. `adoptionDeclined` shows all of it, and [its rollback cost](#limitations) applies again. Read a new listed
  field through `json_extract` over `data` first when that is enough.

## Tests

- `shared/structuredMemory.test.ts` drives `projectHypaV3Data` with plain records; it needs no fakes.
- `server/src/tests/memoryStore.test.ts` drives `createResourceStore` on a real file, with a read-only second connection
  to see the rows, a SQLite trigger to fail a write midway, and `installSnapshot` for restores.
- `server/src/tests/restoreStage.test.ts` drives a crafted source through the real staging and install, and
  `backups.test.ts` drives the snapshot and archive routes. Both take their records from `tests/memoryFixtures.ts`.
- `server/src/tests/structuredMemoryRoutes.test.ts` drives the routes on a real app, and seeds them through a second
  store on the same file, because the app does not export its own. A frozen `Date` holds the rate limit window.
- `src/ts/process/structuredMemory.test.ts` runs in Node with `authFetch` scripted. Its splitters read a file only by
  metadata and line counts, as a reader must. It cannot use `testSupport.ts`: a `src/` test puts its imports under the
  root `tsconfig.json`, where the server routes do not type-check.
- `structured/edits.test.ts` drives the edit rules with plain records. `structuredMemoryRoutes.test.ts` drives the real
  fence on a real app, holding a task on a tokenizer read and a job on its runner.
- The adoption choice: `memoryStore.test.ts` for the decline and a real two-column table opened in place,
  `restoreStage.test.ts` for two-column snapshots, the column's values, and a checkpoint,
  `structuredMemoryRoutes.test.ts` for the routes and the feed, `memoryTasks.test.ts` and `memoryJobs.test.ts` for the
  hold, `assemble.test.ts` for a held send, and `StructuredMemoryPanel.test.ts` for the choice. The reset:
  [projection](projection.md#tests).
- Focused command: `pnpm --silent test:agent structuredMemory memoryStore restoreStage backups edits`. No `slow` or
  `e2e` membership of its own; `backups.test.ts` holds other slow cases.
- Not tested: the types and limits themselves, which `pnpm check` covers only for the code that uses them.

## Known Hazards

### Limitations

- The `adoptionDeclined` column costs a rollback. Builds before it refuse later snapshots whole
  (`invalid memory table columns`), even without a decline. They open and write upgraded live databases, but then refuse
  their own snapshots because those include the column. Their upstream export reads no memory events, so a chat needing
  the projection exports as `memory-unreadable`. They ignore declines and can record or adopt despite one. Decision:
  Structured Memory slice 6c, archive.
- The package holds no runs and no page history. Decision: Structured Memory slice 1d, archive.
- A round is bounded but the tab holds the whole package, and `zipSync` runs on the main thread. The table of contents
  has no budget of its own: it grows with the record count and the titles. Decision: Server Byte Budgets D2, archive.
- A page's creation cannot be reverted: that would delete the page and everything citing it. Decision: Structured Memory
  slice 7b, archive.
- Two reverts newest first and then a branch cut between them keep the older entry's `revertedBy`, though the cut
  brought its text back: the badge is wrong and the entry cannot be undone, and the writer is told nothing, since its
  list comes from the `revert` entries the cut dropped. Decision: Structured Memory slice 7b, archive.

### Gotchas

- The limits are starting values. Only `keyLinesPerEvent`, `pageCandidates`, `consecutiveFailures`, `axisMax`,
  `gradeMax`, `importantEventGrade`, and `dedupeSimilarity` are design numbers.
