# Structured Memory: Records, Tables, Store, Routes, Package, Projection

## Scope

- Owns the `structuredMemory` algorithm's records: their shapes and limits, the tables and store, read and edit routes,
  the tab's client and Markdown package, and the HypaV3 compatibility projection.
- Paths: `shared/structuredMemory.ts`, `server/src/data/memoryStore.ts`, `server/src/routes/structuredMemory.ts`,
  `server/src/prompt/memory/structured/` (the writer's files: [the writer guide](structured-memory-writer.md); the read
  path's: [the read path guide](structured-memory-read.md); `reconcile.ts`, `inherit.ts`, and `restore.ts`:
  [the lifecycle guide](structured-memory-lifecycle.md)), and `src/ts/process/structuredMemory.svelte.ts` (its receipt
  and panel parts: [the read path guide](structured-memory-read.md)).
- The Memory settings page selects it, ahead of the flags. Production has its [writer](structured-memory-writer.md), and
  `assemblePrompt` runs [the read path](structured-memory-read.md). The page exposes only the preset fields something
  reads. Its design and remaining work are in [Active Plans](../plan/README.md).
- Not here:
  - The writer's settings, windows, task kind, runs, analysis prompt, admission, and record now →
    [structured memory writer](structured-memory-writer.md).
  - The read path's lanes, card, manifest, and report, the receipts, and the memory panel in the tab →
    [structured memory read path](structured-memory-read.md).
  - Reconciling events with the chat's messages and the repairs, retraction and re-recording, what a checkpoint holds of
    the records, what a copied or branched chat inherits, and what a chat file carries and an imported chat restores →
    [structured memory lifecycle](structured-memory-lifecycle.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](memory.md).
  - `Chat.hypaV3Data` and its write rules → [memory](memory.md), `shared/memory.ts`.
  - The resource store's connection, epoch, and transactions → [server resources](server-resources.md).

## Files

- `shared/structuredMemory.ts`: types and pure rules only, safe in the tab and on the server.
  - `STRUCTURED_MEMORY_ALGORITHM`: the persisted discriminator.
  - `STRUCTURED_MEMORY_LIMITS`: the record limits, `CHARACTER_SECTION_SLOTS`: the fixed character sections, and
    `MEMORY_SECTION_BUDGETS`: what [compaction](structured-memory-writer.md#compaction) holds a section to.
  - Records: `MemoryEvent`, `MemoryPage`, `MemorySection`, `MemoryThread`, `MemoryRun`, `MemoryReceipt`.
  - Writer output: `MemoryEventDraft`, `MemoryAnalysisResult`, `MemoryPageCandidate`.
  - Evidence anchors: `MemorySource`, `MemoryAnchoredSource`, `MemoryUnanchoredSource`.
  - Chat files: `StructuredMemoryFileRecords`, `StructuredMemoryFileEntry`, `MEMORY_RESTORE_BODY_BYTES`.
  - Per-send: `MemoryManifest`, `MemoryManifestItem`.
  - `projectHypaV3Data`: the `SerializableHypaV3Data` view of a chat's events.
  - `memoryGrade`: a record's grade from its axes. `memoryThreadEnded`: `done` and `cancelled`. `writerPaused`: the
    pause rule, shared with the panel's writer line; `writer.ts` re-exports it.
  - The raw window, shared with the tab: `ReadEntry`, `RawWindow`, `rawWindow`, `coveredMessages`, `memoryEventCovers`.
- `server/src/data/memoryStore.ts`: `createMemoryTables`, the synchronous reads and the writes over the tables;
  `MemoryChanges`, `MemoryContents`, `MemoryRowTexts`; `checkMemoryRow`, the one check of a record's stored text;
  `messageSourceHash`, what a `MemoryAnchoredSource` keeps as its `hash`.
- `server/src/data/chatStore.ts`: `MEMORY_TABLES_SQL`, part of `CHAT_OPEN_SCHEMA_SQL`.
- `server/src/data/resourceStore.ts`: `store.memory`, `readContents`, `readRecord`, and `write`. The checkpoint's part:
  [the lifecycle guide](structured-memory-lifecycle.md#files).
- `server/src/routes/structuredMemory.ts`: `registerStructuredMemoryRoutes`. Its path and answers are shared:
  `STRUCTURED_MEMORY_PATH`, `MEMORY_RECORD_KINDS`, `MEMORY_RUNS_ROUND_ROWS`, `StructuredMemoryContentsAnswer`,
  `StructuredMemoryRecordAnswer`, `StructuredMemoryPackageRound`, `StructuredMemoryCoverageRound`,
  `StructuredMemoryRunsRound`, `StructuredMemoryThreadsRound`, `StructuredMemoryLogRun`, `StructuredMemoryEdit`,
  `StructuredMemoryEditAnswer`, `StructuredMemoryInheritAnswer`, `StructuredMemoryRestoreAnswer`.
- `server/src/prompt/memory/structured/edits.ts`: what a person's edit does, pure: `parseMemoryEdit`, `applyPageEdit`,
  `applyThreadEdit`, `MemoryEditRefusal`. The repairs, `applyEventRepair` and `flagUnsupportedSections`:
  [the lifecycle guide](structured-memory-lifecycle.md#files).
- `src/ts/process/structuredMemory.svelte.ts`: the reads `readStructuredMemoryContents`, `readStructuredMemoryRecord`,
  `readStructuredMemoryCoverage`, `readStructuredMemoryRuns`, `buildStructuredMemoryPackage`,
  `buildStructuredMemoryLog`, which answer a `StructuredMemoryResult`; `editStructuredMemory`; the pure
  `renderMemoryPage`, `renderMemoryTimeline`, and `memoryPagePath`.

## Flows

### The read routes

All are `GET` under `STRUCTURED_MEMORY_PATH/:characterId/:chatId`, authenticated, rate-limited, and epoch-checked (412
`EpochMismatch`), with the check and every store read in one synchronous step. Ids are checked first (400).

- The chat's path answers the table of contents; `/records/:kind/:id` answers one record of a `MEMORY_RECORD_KINDS` kind
  as stored. A missing chat or record is 404 with `reason` `chatGone` or `recordGone`.
- `/package?cursor=N&revision=R` answers one round of the chat's pages followed by its events, in contents order, whole
  records as stored. It charges each record's `bytes` from the contents, so it reads no body it will not send. The
  budget is `RouteLimits.memoryPackageRoundBytes`, default `MAX_READ_RESPONSE_BYTES`, and soft as
  [the read budget](server-resources.md#read-budget) is: a round's first record is served whatever its size. `next` is
  the position to continue from, null at the end.
- `/coverage?cursor=N&revision=R` answers one round of the chat's events followed by its runs that are not `recorded`:
  what each says of its messages (`messageIds`), an event's title and `sourceIndex` (the smallest stored anchored
  position, for an event with no message left), and a run's `reason`, or its receipt's, which is where a failed run
  keeps its code. No error and no message text. The list comes from the contents, so a recorded run's `input` is never
  parsed.
- An event in that round also answers its `sources`, `keptState`, and `rerecord`, because
  [the tab reconciles](structured-memory-read.md#the-memory-panel): `status` there is the stored one, and the route
  reads no chat, whose read parses every message.
- `/runs?cursor=N&revision=R` answers one round of the chat's runs, newest first, without `input` and
  `settingsFingerprint`, and `total`. A round also stops at `MEMORY_RUNS_ROUND_ROWS`, however small the runs are.
- `/threads?cursor=N&revision=R` answers one round of the chat's threads, in contents order, whole records as stored,
  which [a chat file](structured-memory-lifecycle.md#chat-files) reads beside `/package`.
- All three charge and budget as `/package` does, before any record is read: a round's first record is served whatever
  its size.
- `revision` is compared whole as an opaque token, and a different one is 409 naming the current one. A round is one
  snapshot, and that comparison is what ties rounds into one.

### The edit route

`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/edits`, `{ revision, edit }`, capped at 64 KiB, answers
`StructuredMemoryEditAnswer`: the record as it now stands, with the revision the next edit names. `edit` is the closed
union `StructuredMemoryEdit`, one change per request, so the tab never sends a record and cannot set history, evidence,
a type, or an id.

1. Ids, the body, and the edit's shape: 400, a blank or over-long section body included.
2. Epoch (412), then, with no await from here to the write, `fenced` (409 `reason: "fenced"`): the chat's task queued or
   running, or a job or generation lock holding the chat. The job half is what stops a writer's retry after a revision
   conflict from reapplying an old answer over a person's edit, because a record-now job or a send's gap run has no
   task.
3. The record is read and the edit applied to it. A missing chat, record, or heading is 404 `chatGone` or `recordGone`,
   a change the record refuses is 400, and a `keep` that names a state the chat has left is 409 `reason: "changed"`.
4. `store.memory.write` at the client's `revision`, stale 409. An edit that changes nothing goes through as an empty
   change set, so a stale one is still refused.

What an edit does (`edits.ts`):

- A section body gains one `edit` history entry with no `eventId`, bounded by `pageHistoryEntries`, and
  `userCorrected: true`. `provenance`, `sources`, and `unsupported` stay, since the edit changes no evidence; `disputed`
  goes, because a person's edit is the review a dispute waits for. A locked section can be edited: the lock binds the
  writer.
- A lock takes no history entry and no `updatedAt`. A grade sets `gradeByUser`, and null clears both.
- The scene page's `contextMode` stays `always`.
- A thread takes any state, and leaving an ended one drops `closedBy`.
- [A repair](structured-memory-lifecycle.md#reconciliation-and-repairs) acts on an event, and reads the chat in that
  same step unless it is a retract.

### The restore route

`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/restore` gives an imported chat the records its file held, after the
whole shape check of `parseRestoredRecords`, and only when the chat holds no row. Its steps are in
[Chat files](structured-memory-lifecycle.md#chat-files).

### The Markdown package

`buildStructuredMemoryPackage` reads every round, renders in the tab, and answers `{ name, bytes }` for `downloadFile`.
A 409 restarts the read with nothing kept, 3 attempts in all, then refused `changed`. A 412 calls `epochMismatch` and
ends the read at once.

- The zip holds `timeline.md` and `pages/<type>/<title part> [<id part>].md`, one per page.
- Metadata is the authority and Markdown is display. A metadata line is `key: <JSON>`, which is valid YAML on one line;
  `\u` escapes cover what YAML does not print.
- A page's frontmatter has every field but `history`, and `sections` without bodies but with `bodyLines`. Each body
  follows verbatim under a `##` line. `heading` in the frontmatter is the exact value; the `##` line collapses
  whitespace.
- `timeline.md` opens with `packageVersion` and `revision`. Each event is a `##` line, a `yaml` fence with every field
  but `summary`, plus `summaryLines`; then the summary verbatim, then one quote line per key line.
- `bodyLines` and `summaryLines` count `split("\n")` pieces. They are what splits a body holding `## x`, a fence, or
  `---`, so a reader counts lines and never searches for a delimiter.
- Events sort by their smallest anchored source `index`, which is the position when recorded, not the current one. An
  event with no anchored source goes last, and ties keep contents order.

### A memory write

`store.memory.write(characterId, chatId, { epoch, baseRevision }, changes)` commits one declarative change set in its
own transaction. Nothing async can run inside it.

1. Another epoch, or none, is a `ResourceEpochError`. A missing chat is a `ResourceConflictError` with `current: null`,
   and a `baseRevision` that is not the current token one naming the current token.
2. A change set that names nothing stops here: it answers the current token and writes nothing, not even a
   `memory_state` row. A stale empty write is still refused.
3. Every record is checked before anything is written, so a `ResourceValidationError` changes nothing: an id repeated
   within a kind, or both written and removed; an invalid id; a `title` that is not a string; a closed value outside its
   `const` list; a stored text over `MAX_READ_RESPONSE_BYTES`;
   [a second scene page, or losing the one a chat has](structured-memory-writer.md#the-scene-page).
4. Removals, then upserts, then the revision moves up by exactly one, however much changed. Removing an absent id is no
   refusal and still moves it.

The write publishes nothing: the chat's revision and the change feed stay as they were, and it counts toward snapshots
like a checkpoint write.

### The HypaV3 projection

`projectHypaV3Data(events, manifest)` answers a reader that expects `hypaV3Data`, without storing anything.

- Only `active` events become summaries, in the given order; `retracted` and `stale` ones are left out. `text` is the
  event's `summary`, and `chatMemos` are its source message ids.
- `isImportant` holds for a pinned event or one graded `importantEventGrade` (6) or above.
- `metrics` comes from the last manifest and is absent without one. Indices are positions in the projected `summaries`,
  never in `events`, because every metrics reader indexes `summaries`.
- A metric records why that send selected a record, so only `verified` event items count: `flow` fills
  `lastRecentSummaries`, `events` fills `lastSimilarSummaries`, and an event in both lanes is in both arrays.
  `lastImportantSummaries` and `lastRandomSummaries` stay empty: no lane selects by importance or at random, and a pin
  set after the send must not rewrite that send's reasons. `lastDeferredSummaries` is absent.

## State

- A chat's records are events, pages, and threads, with the chat's own messages as the evidence. Each writer run leaves
  a `MemoryRun`, and each recorded turn a `MemoryReceipt`.
- `MemoryEventDraft` is what the writer returns; `MemoryEvent` adds what code owns (id, sources, status, grade, repeat
  count). `MemoryRun.analysis` keeps the bounded draft before evidence checks and deduplication, so the log shows what
  the model said even when `eventId` names something else. `MemoryRun.receipt` holds what the run listed; a message's
  `generationInfo.memory` is its copy, or what the send said ([Receipts](structured-memory-read.md#receipts)).
- A grade is the sum of a record's axes, 0 to 9; a record without axes has none.

### Memory tables

The tables sit in `data/resources.sqlite`, keyed by the chat's incarnation `chats.seq` with `ON DELETE CASCADE`, so a
deleted and recreated chat inherits nothing. Routes still address a chat by `(characterId, chatId)`. Created when
missing, with no version change, and outside the required snapshot layout: all five are an optional group, like the
[checkpoint tables](server-resources.md#checkpoint-tables). A snapshot from before them restores with none, a partial
group is refused, and a full one is checked and restored.

- `memory_state` (`chatSeq` primary key, `revision`): one revision over all of a chat's records. A chat has no row until
  its first write, and an existing chat with no row is at revision 0.
- `memory_pages` (`type`, `title`), `memory_events` (`title`, `status`, `createdRevision`), `memory_threads` (`title`,
  `state`), `memory_runs` (`result`): each with `seq` autoincrement, `chatSeq`, `id`, and `data`, the whole record as
  stored JSON, unique `(chatSeq, id)`. Sections stay embedded in the page's row.
- `seq` is storage order, not message order; an update keeps it, because upserts never use `INSERT OR REPLACE`.
- A restore (`walkMemorySnapshot`, `createMemoryStagingSink`, `copyStagedMemory`) keeps `data` and every revision as
  stored, gives records fresh `seq`s in the source's order, and moves `chatSeq` through the staged chat seq map. The
  listed columns come from the record, never from the source's columns, which a live write can leave unequal (a title
  with a lone surrogate binds as U+FFFD and stays an escape in `data`).

## Coupling

- The projection's return type and metric names come from `shared/memory.ts`. `HypaV3Modal.svelte` and
  `remapHypaV3Metrics` read each metric array independently, so an index may sit in two arrays.
- The persisted value `memoryAlgorithmType` is a plain string in `shared/database.ts`; `structuredMemory` selects ahead
  of the [selection chain](memory.md#selection-in-assembleprompt) that reads the flags, which [memory](memory.md) owns.
- The tables follow the [epoch rules](server-resources.md#epoch-and-response-rules) and the snapshot walk of
  [server resources](server-resources.md#snapshots-and-restore). `readSnapshotFile` passes no memory sink: the upstream
  export neither reads the tables nor stops on a problem in them.
- The memory revision says nothing about the chat's messages. A whole-chat `replace` keeps `chats.seq`, so the rows and
  the revision survive it, and only the memory task's fence stops a writer working from the old messages
  ([memory](memory.md)). A checkpoint load replaces the rows too
  ([A checkpoint](structured-memory-lifecycle.md#a-checkpoint)).
- The route answers are shared types because tab code never imports `server/`; each route answers with `satisfies`, so a
  store type that drifts fails `pnpm check`.
- `app.ts` admits the routes as resource handlers: tracked, refused during shutdown, and `no-store`. `ROUTE_TEMPLATES`
  in `shared/diagnostics.ts` lists each route.

## Invariants

- Server code writes the tables only through `store.memory`, synchronously, after the task's or route's fence check. The
  exceptions are a restore's staged writer and install copy, a checkpoint load's `tx.restoreMemory`, in the load's
  transaction under its writer lease, and `reconcileMessageChanges`, which holds no fence
  ([Retraction and edits](structured-memory-lifecycle.md#retraction-and-edits)).
- A route writes a closed edit applied to the record as stored ([the edit route](#the-edit-route)), or on
  [the inherit route](structured-memory-lifecycle.md#copies-and-branches) the records the server builds from the source
  chat. [The restore route](#the-restore-route) is exactly the one route that writes records the tab sent: for a chat
  with no rows, after `parseRestoredRecords`.
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
- `MemoryManifest.items` holds included items only; excluded candidates never reach the projection.
- Code owns grades: a draft carries scored axes, and only the stored `MemoryEvent` and `MemoryKnowledge` carry `grade`.

## Recipes

- A new persisted record field: add it to the shape in `shared/structuredMemory.ts`, optional unless every stored record
  will have it, give it [a check](structured-memory-lifecycle.md#recipes) in `structured/restore.ts`, and extend this
  guide's contract.
- A new closed value: append to its `const` list; a validator reads the list, so it follows.
- A new column: `CREATE TABLE IF NOT EXISTS` never extends a table, so it needs its own migration in `openChatSchema`,
  and `MEMORY_TABLE_COLUMNS` matches exactly, so the walk must also take a snapshot of the old layout. Read a new listed
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
- Focused command: `pnpm --silent test:agent structuredMemory memoryStore restoreStage backups edits`. No `slow` or
  `e2e` membership of its own; `backups.test.ts` holds other slow cases.
- Not tested: the types and limits themselves, which `pnpm check` covers only for the code that uses them.

## Known Hazards

### Limitations

- The package holds pages and events only: no threads, runs, or page history. Decision: Structured Memory slice 1d,
  plan.
- A round is bounded but the tab holds the whole package, and `zipSync` runs on the main thread. The table of contents
  has no budget of its own: it grows with the record count and the titles. Decision: Server Byte Budgets D2, archive.

### Gotchas

- The limits are starting values. Only `keyLinesPerEvent`, `pageCandidates`, `consecutiveFailures`, `axisMax`,
  `gradeMax`, `importantEventGrade`, and `dedupeSimilarity` are design numbers.
