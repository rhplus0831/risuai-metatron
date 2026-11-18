# Structured Memory Records: Shapes, Tables, Store, Routes, Package

## Scope

- Owns the `structuredMemory` algorithm's records: their shapes and limits, the tables and store, read and edit routes,
  and the tab's client and Markdown package.
- Start with the record contracts below. Chat algorithm selection and enablement use `shared/chatMemory.ts`. A stored
  chat mode takes precedence over the legacy settings.
  [Selection in assemblePrompt](../memory.md#selection-in-assembleprompt)
- Follow [the area index](README.md) for projection, writers, lifecycle, rebuild and page tools, or
  [server resources](../server-resources.md) for database transactions, snapshots and epochs.

## Files

- `shared/structuredMemory.ts` owns persisted record shapes (`MemoryEvent`, `MemoryPage`, `MemoryThread`, `MemoryRun`),
  their limits (`STRUCTURED_MEMORY_LIMITS`), evidence (`MemorySource`, `MemoryGreetingSource`) and the tab/server
  contracts under `STRUCTURED_MEMORY_PATH`. Follow the route's `satisfies` annotation to its exact answer type.
  `MemoryReceipt` links the writer's result to the saved chat message and `MemoryManifest` describes the send. Display
  chapters use `MemoryChapter`, `isMemoryChapter`, `memoryChapterMark` and `memoryChapterUnits`.

- `server/src/data/memoryStore.ts`: synchronous record storage; `createMemoryTables`, `MemoryChanges`, `MemoryContents`,
  `MemoryRowTexts`, `readContents`, `readKindPage`, `readRecord`, `write`, `checkMemoryRow`; `messageSourceHash`
  supplies source hashes and `greetingSourceHash` greeting hashes. `orderMemoryEvents` places events by their earliest
  source for chapters and for `projectChatMemory` after reconciliation. The projection's part:
  [projection](projection.md#files).
- `server/src/data/chatStore.ts`: table declarations; `MEMORY_TABLES_SQL`, `MEMORY_CHAPTERS_SQL`,
  `CHAT_OPEN_SCHEMA_SQL`.
- `server/src/data/resourceStore.ts`: transaction and epoch boundary; `store.memory`, `readContents`, `readRecord`,
  `write`, and `store.memory.chapters` over `createChapterTables` in the memory store. Other parts:
  [projection](projection.md#files), [checkpoints](lifecycle.md#files).
- `server/src/routes/structuredMemory.ts`: HTTP contracts and admission; `registerStructuredMemoryRoutes`, `roundOf`.
- `server/src/app.ts`: route registration and fence wiring; `registerStructuredMemoryRoutes`, `chatHeld`, `fenced`.
- `server/src/prompt/memory/structured/edits.ts`: pure edit admission and application; `parseMemoryEdit`,
  `applyPageEdit`, `applyThreadEdit`, `applyEventText`, `applyEventRelease`, `MemoryEditRefusal`. Repairs
  (`applyEventRepair`, `flagUnsupportedSections`): [lifecycle](lifecycle.md#files).
- `server/src/prompt/memory/structured/pages.ts`: revert rules; `revertChange`, `revertGroup`, `revertedSection`,
  `laterEventCount`. Owner: [page tools](pages.md).
- `server/src/prompt/memory/structured/writer.ts`: pause-rule re-export shared with the panel's writer line;
  `writerPaused`. Owner: [writer](writer.md).
- `src/ts/process/structuredMemory.svelte.ts`: tab route client and package renderer; `StructuredMemoryResult`,
  `readStructuredMemoryContents`, `readStructuredMemoryRecord`, `readStructuredMemoryCoverage`,
  `readStructuredMemoryStory`, `findStructuredMemory`, `readStructuredMemoryRuns`, `readStructuredMemoryHealth`,
  `readStructuredMemoryChapters`, `removeStructuredMemoryChapters`, `editStructuredMemory`,
  `buildStructuredMemoryPackage`, `buildStructuredMemoryLog`, `renderMemoryPage`, `renderMemoryTimeline`,
  `renderMemoryThreads`, `memoryPagePath`, `memoryGreetingHash`.

## Flows

### The read routes

The tab's reads reach `server/src/routes/structuredMemory.ts` through `STRUCTURED_MEMORY_PATH`. Routes authenticate,
rate-limit and check the epoch (412 `EpochMismatch`). The route header owns paths, answers, round ordering, limits and
refusals. Epoch check and store reads share one synchronous step: each round is one snapshot; only the opaque `revision`
comparison ties rounds together.

- The panel reads contents and records through `store.memory.readContents` and `store.memory.readRecord`. Contents also
  supplies adoption and rebuild state, the recorded language, health, and unsupported page IDs. When the stored chat
  bindings resolve, `writerBlockingReason` uses its bound memory connection and request triggers to explain a blocked
  background writer without loading messages. A tab joins the panel's in-flight contents read unless a write answer
  settled since it began.
- Coverage sends stored facts (`status`, `sources`, `keptState`, `rerecord`, the normalized `greeting` and
  `greetingKept`, and whether a run read the greeting) for [the tab to reconcile](read.md#the-memory-panel) against its
  held messages, reading no chat. A greeting citation's `sourceIndex` is -1.
- `/story` sends each event's `summary`, `storyTime`, `participants` and `grade` as stored, retracted events included,
  for [Timeline's story read](read.md#pages-timeline-and-threads), which joins them by id with the coverage rows it
  holds; an ungraded event has no `grade` key. Its rounds charge stored bytes as `/coverage`'s do.
  `readStructuredMemoryStory` gives the tab only well-shaped display fields, since a snapshot row can lack them or carry
  any number: it keeps a `grade` only as an integer from 0 to `gradeMax`.
- `GET .../chapters` returns `StructuredMemoryChaptersAnswer` with the memory revision and all displayable chapters in
  storage order. An existing chat with no chapters answers an empty list. The store sums every chapter row's
  `octet_length(data)` before selecting bodies. Over `memoryPackageRoundBytes` the route answers 413 `tooLarge` and the
  tab's read fails. A malformed row is omitted, and the tab also checks each row with `isMemoryChapter`.
- `GET .../chapters/cost` returns `StructuredMemoryChapterCostAnswer` with the current count of eligible units as
  `{ units }`. It reads the chat, stored events, chapters and bound preset settings without a model call or a write.
- `POST .../chapters/remove` takes `{ ids }` with 1 to 256 valid resource IDs and a 64 KiB body limit. A malformed
  request receives 400. The route checks the epoch, the edit fence (409 `fenced`) and maintenance, then removes by
  stored ID. `StructuredMemoryChapterRemoveAnswer` gives the number removed, including zero for a repeat. All chapter
  routes answer 404 `chatGone` for a missing chat.
- `/find` accepts one trimmed text query (`q`) or one page ID (`page`). Both walk stored-byte rounds at one revision and
  skip retracted events. Text search covers live pages and events. A page lookup returns events and threads naming that
  page, including bounded facts about its knowledge and relationships (`pageMention`). Match and excerpt rules live
  beside `findPageHits` and `findEventHits`.
- `findStructuredMemory` restarts its collection on revision change. Text search stops at the hit cap. For a page lookup
  it reads all rounds and keeps the newest capped lists using current message positions for the events.
  [Pages and Timeline](read.md#pages-timeline-and-threads)

- Package and [chat-file](lifecycle.md#chat-files) reads collect `/package` and `/threads` at one revision. A round
  reads the revision alone and lists only its kinds: `/runs` and `/threads` by `seq` cursor (`readKindPage`), the others
  by position. The byte budget comes from `RouteLimits.memoryPackageRoundBytes` in `server/src/app.ts`, default
  `MAX_READ_RESPONSE_BYTES`; `roundOf` defines charging before body reads and the soft first-record rule. `/runs` feeds
  the Log; `/cost` is [rebuild's cost preview](rebuild.md#the-cost-preview), with no record sent.
- `GET /default-prompts` returns the server's prompt frames and slot text for the settings editor.
  [Prompt fine-tuning](read.md#prompt-fine-tuning) owns that flow. The plugin's batched `POST /revisions` and per-chat
  `GET .../projection` are in [projection](projection.md).
- The Log and its JSON export show `patchInput` only for runs whose prompts [the prune](writer.md#a-writer-run) retains:
  every pending run and the newest failed or skipped run, even with a newer recorded run.
- `readStructuredMemoryHealth` calls `POST /health` for [the badge](read.md#the-health-badge), charging live pages,
  events and runs, reading no messages. An answer can be a prefix the tab resumes; a chat over the round budget answers
  `unavailable`, in contents too. The route header defines the caps.

### The edit route

The panel calls `editStructuredMemory` with the revision of its read and one `StructuredMemoryEdit`. The route header
defines the request, body cap and refusals; `parseMemoryEdit`, `applyPageEdit`, `applyThreadEdit`, `applyEventText`, and
`applyEventRelease` own admission and the changes to stored records.

Every structured-memory mutation checks the restore maintenance gate after body reads, in the same synchronous step as
the mutation, and refuses with the resource routes' 503 and `Retry-After` while maintenance is active.

1. The route checks ids, body and edit shape, then the epoch, then the fence. From the epoch check through
   `store.memory.write` there is no await. `server/src/app.ts` supplies the fence: a queued/running task, a job or
   generation lock, or a rebuild's run, including a stopped one, refuses 409 `fenced`. A send's gap run has no task;
   in-job [record now](writer.md#record-now) publishes `openJobStatus` when the service exists. The job fence keeps
   [a writer's retry](writer.md#a-writer-run) of an old answer, and the rebuild fence its swap, from overwriting the
   edit.
2. The route reads the stored record, applies the pure edit and calls `store.memory.write` at the client's revision. A
   no-op still sends an empty change set through the revision check, so a stale edit is refused too.
3. `StructuredMemoryEditAnswer` gives the current record and the revision the next edit must name.

[Event repairs](lifecycle.md#reconciliation-and-repairs) call `applyEventRepair`, reading the stored chat in the same
step except for retract. Retraction also passes through `withRetractedEvidence` before the write. A `keepGreeting` names
the greeting the panel showed: the route reads the owner for the chat's greeting, refuses `changed` when it no longer
equals that one and `invalid` for an event with no `greeting`, a retracted one, or a chat with no greeting, and
otherwise stores it as `greetingKept`, keeping status, citation, and marks. Keeping again replaces it.

Timeline sends `eventText` or `eventRelease` to change a standing event's title and summary or release its
`userCorrected` mark. These edits read only the event. A retracted event still accepts release. The old text and
evidence survive release. [Re-records](lifecycle.md#reconciliation-and-repairs) and
[rebuilds](rebuild.md#what-a-rebuild-keeps) consult the mark when replacing an event.

`sectionKeep` also reads event statuses so it can drop retracted provenance when clearing `unsupported`. Choosing
`preserve` marks the text as user-corrected for a rebuild. `sectionRelease` clears that mark and leaves the section's
other protections intact. `sectionAdd` creates an unlocked, user-corrected section with empty evidence and a history
entry carrying no event. It applies only to page types with free headings. The shared edit union, `parseMemoryEdit` and
`applyPageEdit` define text limits, no-ops and refusals.

### The revert route

The tab's `revertStructuredMemoryChange` reads the page's current revision, then calls `POST .../revert`. The route uses
the edit route's admission order and fence. The route header owns `StructuredMemoryRevertAnswer`, the cap and refusals.

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

1. The client collects `/package` rounds, then `/threads` at that revision. Trash stays out of the live pages and
   therefore out of the package.
2. The tab renders and zips the records for `downloadFile`. The builder's comment defines retries and the file set;
   `renderMemoryPage`, `renderMemoryTimeline`, `renderMemoryThreads` and `memoryPagePath` define serialization and
   ordering. `StructuredMemoryResult` defines failures and epoch handling.
3. [Package import](pages.md#the-import-route) reads those files back on the server. Metadata is authoritative, and line
   counts, not delimiters, bound text that holds headings, fences or `---`.

### A memory write

`store.memory.write(characterId, chatId, { epoch, baseRevision }, changes)` in `server/src/data/resourceStore.ts`
commits one declarative change set in its own synchronous transaction. After its epoch check,
`server/src/data/memoryStore.ts`'s synchronous `write` owns revision checks, validation, no-ops and write ordering; any
failure rolls back. Inherit and restore share this boundary.

The write publishes nothing: the chat's revision and the change feed stay as they were, and a real write counts toward
snapshots like a checkpoint write.

### Chapter writes

`store.memory.chapters.list(characterId, chatId, budgetBytes = Infinity)` returns the chapters and revision together,
`null` for a missing chat, or `"tooLarge"` if the stored bodies exceed the budget. Each mutation takes the caller's
epoch and owns one synchronous transaction. A successful add or replace counts as one store write. A removal counts once
if any row was deleted. Chapter writes leave the memory revision unchanged.

- `add(characterId, chatId, epoch, chapter)` checks the serialized JSON's shape and its `MAX_READ_RESPONSE_BYTES` bound.
  The chapter needs a fresh ID. Every listed event must exist in this chat, be unretracted, match its mark and belong to
  no other chapter. Even a malformed chapter claims the event ID strings in its stored `events` array.
- `replace(characterId, chatId, epoch, chapterId, chapter)` requires the old chapter to exist and allows its members.
  After all checks it deletes the old row and inserts the replacement with its fresh ID. A removal naming the old ID
  then removes nothing. Both add and replace raise a resource conflict for a missing chat.
- `remove(characterId, chatId, epoch, ids)` deletes matching chapter rows regardless of their contents and returns the
  count, or `null` for a missing chat.

## State

- A chat's records are events, pages, threads and writer runs. An event can cite transcript messages, the eligible solo
  greeting, or both. A recorded window has a receipt on its run. [Writer commits](writer.md#the-writer-task) also copy
  the receipt to eligible assistant messages.
- `MemoryEventDraft` is what the writer returns; `MemoryEvent` adds what code owns (id, sources, status, grade, repeat
  count). `MemoryRun.analysis` keeps the bounded draft before evidence checks and deduplication, so the log shows what
  the model said even when `eventId` names something else. `MemoryRun.receipt` holds what the run listed; a message's
  `generationInfo.memory` is its copy, or what the send said ([Receipts](read.md#receipts)).
- An event's `storyTime` is the writer's free `text`, an optional `ordinal`, and an optional `date` (`MemoryStoryDate`,
  `{ year?, month, day }`). The prompt asks the writer for a date stated in the recorded messages. Admission validates
  the date's form and calendar values. Existing records can omit it. `parseStoryDate`, `formatStoryDate` and
  `isStoryDate` in `shared/structuredMemory.ts` define the shared contract.
- The writer computes event and knowledge grades as the sum of their axes, 0 to 9, omitting `grade` without axes. Pages
  can hold a person's grade without axes; `gradeByUser` marks that choice (`applyPageEdit`).
- A `MemoryChapter` has a resource `id`, a `title` up to `eventTitleChars`, a `synopsis` up to `chapterSynopsisChars`
  (1,200), and a nonempty list of `{ id, mark }` in story order, each with a unique event ID and a string mark.
- `memoryChapterMark` applies `textHash` to the JSON tuple of title, summary and formatted date. A non-string title or
  summary reads as empty, and an absent or invalid date reads as null. The server reads the event's JSON body so the
  mark agrees with coverage's title and the story read's summary and date. The tab, mark and grouping share
  `storedStoryDate`.
- `memoryChapterUnits` takes placed, unretracted events in story order and sets aside the newest `chapterRecentEvents`
  (10). Within each run of loose events, it gathers whole `memoryEventGroups` until it reaches the target size. Invalid
  dates count as absent. A full unit holds from `size` to `2 * size - 1` events. A shorter tail closes if the very next
  event already belongs to a chapter, including the first event set aside. Otherwise it waits.

### Memory tables

The tables sit in `data/resources.sqlite`, keyed by the chat's incarnation `chats.seq` with `ON DELETE CASCADE`, so a
deleted and recreated chat inherits nothing. Routes still address a chat by `(characterId, chatId)`. The four record
tables and `memory_state` are created when missing without a version change. They form an optional snapshot group, like
the [checkpoint tables](../server-resources.md#checkpoint-tables). A snapshot from before them restores with none, a
partial group is refused, and a full one is checked and restored. [A rebuild's staged tables](rebuild.md#state) are not
of the group: no walk reads them.

- `memory_state` (`chatSeq` primary key, `revision`, `adoptionDeclined`): one revision over all of a chat's records, and
  [a person's decline](lifecycle.md#the-adoption-choice), 0 or 1. A chat has no row until its first write, and an
  existing chat with no row is at revision 0. A decline is a write, so it moves the revision and a state row never sits
  at 0, which the snapshot walk refuses.
- `adoptionDeclined` is the first column added to a table that already exists. `SCHEMA_VERSION` stays 3, since the group
  is optional. `openChatSchema` adds it once, every old row reading 0. `MEMORY_TABLES_SQL` has it too, because a
  restore's staged store runs that `CREATE` and never `openChatSchema`. `memoryStateLayout` takes both layouts, and the
  walk reads a two-column snapshot as 0.
- `memory_event_sources` and `memory_staged_event_sources` map `(chatSeq, messageId)` to citing events for
  `readContents`' `citing`. Derived, outside the group: event-write triggers keep them, an older build's too;
  `openChatSchema` backfills them.
- `memory_chapters` is a strict table with an autoincrement `seq`, a cascading `chatSeq` reference, `id` and JSON
  `data`, unique on `(chatSeq, id)`. `CHAT_OPEN_SCHEMA_SQL` creates it when missing at every open with no schema version
  change. Deleting the chat cascades to its chapters. It sits outside the memory table group and all lifecycle walks. A
  native snapshot and the SQLite payload of a native backup archive physically contain its rows. The restore walk skips
  them, and the upstream-compatible export omits them.
- `memory_pages` (`type`, `title`), `memory_events` (`title`, `status`, `createdRevision`), `memory_threads` (`title`,
  `state`), `memory_runs` (`result`): each with `seq` autoincrement, `chatSeq`, `id`, and `data`, the whole record as
  stored JSON, unique `(chatSeq, id)`. Sections stay embedded in the page's row.
- `seq` is storage order, not message order; an update keeps it, because upserts never use `INSERT OR REPLACE`. Runs and
  threads have a `(chatSeq, seq)` index, made at open, so a cursor round sorts nothing.
- A restore (`walkMemorySnapshot`, `createMemoryStagingSink`, `copyStagedMemory`) keeps `data` and every revision as
  stored, gives records fresh `seq`s in the source's order, and moves `chatSeq` through the staged chat seq map. Listed
  columns come from the record, never the source's, which a live write can leave unequal.

## Coupling

- `chatMemoryAlgorithm` in `shared/chatMemory.ts` resolves a chat's explicit mode or the global legacy settings.
  Switching modes changes the send and projection readers while the stored records remain available through the panel
  routes. [Selection in assemblePrompt](../memory.md#selection-in-assembleprompt)

- The tables follow the [epoch rules](../server-resources.md#epoch-and-response-rules) and the snapshot walk of
  [server resources](../server-resources.md#snapshots-and-restore); the export's walk of them is
  [projection](projection.md#the-upstream-export)'s.
- The memory revision says nothing about the chat's messages. A whole-chat `replace` keeps `chats.seq`, so rows and
  revision survive it; only the memory task's fence stops a writer working from the old messages
  ([memory](../memory.md)). A checkpoint load replaces the rows too ([A checkpoint](lifecycle.md#a-checkpoint)).
- Route answers are shared types since tab code never imports `server/`; each answers with `satisfies`, so a drifting
  store type fails `pnpm check`.
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
- A stale record write is refused whole. A retry requires a fresh revision. The store performs no field merge.
- `createdRevision` is the store's: the committing revision on insert, the stored value on update, whatever the input
  held. A caller holds an opaque token, so a write takes `MemoryEventWrite`.
- Every stored record must fit `MAX_READ_RESPONSE_BYTES`, including all of a page's embedded sections. Individual input
  limits such as `sectionBodyChars` also apply to edits. The round budget can serve an oversized first row and charges
  the stored representation. See [known issues](../../backlog/known-issues.md#structured-memory) for the difference
  between stored and re-serialized bytes.
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
- A `MemoryAnchoredSource` hash reads role, `saying` and `data` as `memorySourceText` (tags and comments removed, blank
  lines collapsed), never `generationInfo`, so display markup a plugin adds keeps it; a stored `v2:` or bare hash
  compares under its own version, which reads raw `data` (`messageSourceHash`). The chat store's `rewritten` notice
  stays raw; the [memory reaction](lifecycle.md#retraction-and-edits) applies stored-version and speaker-change rules.
- A `MemoryUnanchoredSource` means the anchor was never known: an adopted summary whose message was already gone. It
  forces its event `stale` until a person keeps it. A source whose message disappears later keeps its original hash and
  index. A run's window holds only anchored sources.
- A solo chat's greeting is cited apart from the message sources: `MemoryEvent.greeting` and `MemoryRun.greeting`, a
  `MemoryGreetingSource` (`fmIndex`, the effective index `greetingIndex` reads, and `hash`). It is no `MemorySource`, so
  the reverse source tables, reconciliation, page sections, and adoption's memo lookup stay message-only, and a record
  without it reads as before.
- A greeting hash is version 3 over `["greeting", memorySourceText(text)]` of the stored, unexpanded greeting
  (`memoryGreetingHashFields`, digested by `greetingSourceHash` and the tab's `memoryGreetingHash`), so a markup change
  keeps it and a CBS value that changes per send does not move it. `greetingCited` needs both fields to match the chat's
  greeting (`memoryChatGreeting`: none for a group, a reset history, or an empty greeting).
- Every reader of a greeting citation goes through `storedMemoryGreeting`, which reads anything but the exact shape as
  none, since runs are raw JSON. `greetingKept` has the same shape; `parseRestoredRecords` refuses either field in
  another shape, and the package version stays.
- A greeting citation covers whether or not it still matches: `coveredMessages` lets the greeting leave the prompt once
  an active, unsuppressed event cites one. `greetingCited` decides only the panel's changed label (where a matching
  `greetingKept` also hides it) and the evidence lane, which excerpts a dropped greeting under
  `MEMORY_GREETING_EVIDENCE_ID` (`.`, never a message id) only for a matching recorded citation.
- Sections carry both `provenance` (event ids) and `sources`, and a history entry's `before` carries all three of body,
  provenance, and sources, so a revert never restores a body with the replacement's evidence. `before` is `null` when
  nothing was replaced, and `heading` is `null` for a change to the whole page.
- The state after a history entry is the next entry's `before` or the live section; no `after` is stored.
- On a character page, a section's `heading` holds a `CHARACTER_SECTION_SLOTS` key, not display text. Other page types
  use free headings.
- The writer's drafts carry scored axes; code computes `grade` on `MemoryEvent` and `MemoryKnowledge`. `MemoryPage` also
  has `grade`: a person's page edit sets `gradeByUser`, and clearing the grade removes both fields (`applyPageEdit`).
- `MemoryPage.namedByUser` marks a title or alias list a person chose with a [page tool](pages.md#rename-and-aliases);
  absent means the writer's naming.

## Recipes

- A new persisted record field: add it to the shape in `shared/structuredMemory.ts`, optional unless every stored record
  will have it, give it [a check](lifecycle.md#recipes) in `structured/restore.ts`, and extend this guide's contract.
- A new closed value: append to its `const` list; a validator reads the list, so it follows.
- A new column: `CREATE TABLE IF NOT EXISTS` never extends a table, so it needs its own migration in `openChatSchema`
  and the `CREATE` too, and `MEMORY_TABLE_COLUMNS` matches exactly, so the walk must also take a snapshot of the old
  layout. `adoptionDeclined` shows all of it, and [its rollback cost](#limitations) applies again. Read a new listed
  field through `json_extract` over `data` first when that is enough.

## Tests

- `shared/structuredMemory.test.ts` exercises source eligibility, greeting citations, story dates and the HypaV3
  projection on plain records.
- `server/src/tests/memoryStore.test.ts` drives `createResourceStore` on a real file, with a read-only second connection
  to see the rows, a SQLite trigger to fail a write midway, and `installSnapshot` for restores.
- `server/src/tests/restoreStage.test.ts` drives a crafted source through the real staging and install;
  `backups.test.ts` the snapshot and archive routes. Both take their records from `tests/memoryFixtures.ts`.
- `server/src/tests/structuredMemoryRoutes.test.ts` drives the routes on a real app, seeded through a second store on
  the same file, since the app does not export its own. A frozen `Date` holds the rate limit window.
- `src/ts/process/structuredMemory.test.ts` runs in Node with `authFetch` scripted. It dynamically imports
  `parseMemoryPackage` by computed path, keeping the server module graph out of the client type check, and round-trips
  the tab's rendered files through that parser. It cannot use `testSupport.ts`: a `src/` test puts its imports under the
  root `tsconfig.json`, where the server routes do not type-check.
- `structured/edits.test.ts` drives the edit rules with plain records. `structuredMemoryRoutes.test.ts` drives the real
  fence on a real app, holding a task on a tokenizer read and a job on its runner, and the maintenance gate on every
  mutation, including after a delayed body read.
- The adoption choice: `memoryStore.test.ts` for the decline and a real two-column table opened in place,
  `restoreStage.test.ts` for two-column snapshots, the column's values, and a checkpoint,
  `structuredMemoryRoutes.test.ts` for the routes and the feed, `memoryTasks.test.ts` and `memoryJobs.test.ts` for the
  hold, `assemble.test.ts` for a held send, and `StructuredMemoryPanel.test.ts` for the choice. The reset:
  [projection](projection.md#tests).
- Focused command: `pnpm --silent test:agent structuredMemory memoryStore restoreStage backups edits`. No `slow` or
  `e2e` membership of its own; `backups.test.ts` holds other slow cases.

## Known Hazards

### Limitations

- Chapters are local display data. A restore, an import, a chat file, the Markdown package and a checkpoint do not carry
  them. Prompt construction and the HypaV3 projection read the underlying memory records. Decision: owner, 2026-11-18.
- The `adoptionDeclined` column costs a rollback. Builds before it refuse later snapshots whole
  (`invalid memory table columns`), even without a decline. They open and write upgraded live databases, but then refuse
  their own snapshots because those include the column. Their upstream export reads no memory events, so a chat needing
  the projection exports as `memory-unreadable`. They ignore declines and can record or adopt despite one. Decision:
  Structured Memory slice 6c, archive.
- The package holds no runs and no page history. Decision: Structured Memory slice 1d, archive.
- A round is bounded but the tab holds the whole package, and `zipSync` runs on the main thread. The table of contents
  has no budget of its own: it grows with the record count and the titles. Decision: Server Byte Budgets D2, archive.
- A `sectionKeep` without `preserve` leaves text that no message supports and no mark protects, so a full rebuild drops
  it. With `preserve` the section is `userCorrected`: it then survives rebuilds and is never compacted until the writer
  replaces the text or a person releases it. A person's body edit still keeps `unsupported`. Decision: owner,
  2026-11-10.
- A page's creation cannot be reverted: that would delete the page and everything citing it. Decision: Structured Memory
  slice 7b, archive.
- Two reverts newest first and then a branch cut between them keep the older entry's `revertedBy`, though the cut
  brought its text back: the badge is wrong and the entry cannot be undone, and the writer is told nothing, since its
  list comes from the `revert` entries the cut dropped. Decision: Structured Memory slice 7b, archive.

### Gotchas

- The limits are starting values. Only `keyLinesPerEvent`, `pageCandidates`, `consecutiveFailures`, `axisMax`,
  `gradeMax`, `importantEventGrade`, and `dedupeSimilarity` are design numbers.
- A loaded event can lack `storyTime`, `keyLines`, or `participants`, or hold a `storyTime.date` no check has read,
  since `checkMemoryRow` checks a row's columns only. The server's readers take them as empty (`eventBody`,
  `eventVectorTexts`, `remappedEvent`); a new reader must too. An event whose `summary`, `knowledge`, `sources`,
  `keyLines`, or `participants` has the wrong type is skipped by prompt selection, coverage, retrieval, vector warming,
  and recording (`memoryEventHasReadableFields`) and stays stored.
