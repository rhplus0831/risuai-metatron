# Structured Memory: Records, Tables, Store, Routes, Package, Projection

## Scope

- Owns the `structuredMemory` algorithm's records: their shapes and limits, the tables and store, read and edit routes,
  the tab's client and Markdown package, and the HypaV3 compatibility projection.
- Paths: `shared/structuredMemory.ts`, `server/src/data/memoryStore.ts`, `server/src/routes/structuredMemory.ts`,
  `server/src/prompt/memory/structured/` (the writer's files: [the writer guide](structured-memory-writer.md); the read
  path's: [the read path guide](structured-memory-read.md); `reconcile.ts`, `inherit.ts`, and `restore.ts`:
  [the lifecycle guide](structured-memory-lifecycle.md); `rebuild.ts`:
  [the rebuild guide](structured-memory-rebuild.md)), and `src/ts/process/structuredMemory.svelte.ts` (its receipt and
  panel parts: [the read path guide](structured-memory-read.md)).
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
  - A chat's rebuild and backfill, the staged tables, and the cost preview →
    [structured memory rebuild](structured-memory-rebuild.md).
  - The trash, merge, split, the lorebook export, and importing a package →
    [structured memory page tools](structured-memory-pages.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](memory.md).
  - `Chat.hypaV3Data` and its write rules → [memory](memory.md), `shared/memory.ts`.
  - The resource store's connection, epoch, and transactions → [server resources](server-resources.md).

## Files

- `shared/structuredMemory.ts`: types and pure rules only, safe in the tab and on the server.
  - `STRUCTURED_MEMORY_ALGORITHM`: the persisted discriminator. `ADOPTED_WRITER_RUN`: the `writerRun` of an adopted
    event, which names no run.
  - `STRUCTURED_MEMORY_LIMITS`: the record limits, `CHARACTER_SECTION_SLOTS`: the fixed character sections, and
    `MEMORY_SECTION_BUDGETS`: what [compaction](structured-memory-writer.md#compaction) holds a section to.
  - Records: `MemoryEvent`, `MemoryPage`, `MemorySection`, `MemoryThread`, `MemoryRun`, `MemoryReceipt`.
  - Writer output: `MemoryEventDraft`, `MemoryAnalysisResult`, `MemoryPageCandidate`.
  - Evidence anchors: `MemorySource`, `MemoryAnchoredSource`, `MemoryUnanchoredSource`.
  - Chat files: `StructuredMemoryFileRecords`, `StructuredMemoryFileEntry`, `MEMORY_RESTORE_BODY_BYTES`.
  - Per-send: `MemoryManifest`, `MemoryManifestItem`.
  - `projectHypaV3Data`: the `SerializableHypaV3Data` view of a chat's events. `sealHypaV3Data`, `isSealedHypaV3Data`,
    `sealedHypaV3DataIntact`, `sealedHypaV3DataRevision`: the mark a read's projection carries.
    `hypaV3DataHoldsSummaries`: what owns the field.
  - `memoryGrade`: a record's grade from its axes. `memoryThreadEnded`: `done` and `cancelled`. `writerPaused`: the
    pause rule, shared with the panel's writer line; `writer.ts` re-exports it.
  - The raw window, shared with the tab: `ReadEntry`, `RawWindow`, `rawWindow`, `coveredMessages`, `memoryEventCovers`.
- `server/src/data/memoryStore.ts`: `createMemoryTables`, the synchronous reads and the writes over the tables;
  `MemoryChanges`, `MemoryContents`, `MemoryRowTexts`; `checkMemoryRow`, the one check of a record's stored text;
  `messageSourceHash`, what a `MemoryAnchoredSource` keeps as its `hash`; `projectChatMemory`, a chat's unsealed
  projection, shared by the read and the export.
- `server/src/data/chatStore.ts`: `MEMORY_TABLES_SQL`, part of `CHAT_OPEN_SCHEMA_SQL`.
- `server/src/data/resourceStore.ts`: `store.memory`, `readContents`, `readRecord`, and `write`;
  `sealedMemoryProjection`, the projection's one rule, for `overlayMemoryProjection`, `readProjection`, and
  `readProjectionRevisions`. The checkpoint's part: [the lifecycle guide](structured-memory-lifecycle.md#files).
- `server/src/routes/structuredMemory.ts`: `registerStructuredMemoryRoutes`. Its path and answers are shared:
  `STRUCTURED_MEMORY_PATH`, `MEMORY_RECORD_KINDS`, `MEMORY_RUNS_ROUND_ROWS`, `StructuredMemoryContentsAnswer`,
  `StructuredMemoryRecordAnswer`, `StructuredMemoryPackageRound`, `StructuredMemoryCoverageRound`,
  `StructuredMemoryRunsRound`, `StructuredMemoryThreadsRound`, `StructuredMemoryLogRun`, `StructuredMemoryEdit`,
  `StructuredMemoryEditAnswer`.
- The route answers of a copy, a chat file, adoption, and the reset, shared too: `StructuredMemoryInheritAnswer`,
  `StructuredMemoryRestoreAnswer`, `StructuredMemoryAdoptAnswer`, `StructuredMemoryDeclineAnswer`,
  `StructuredMemoryResetAnswer`, `StructuredMemoryAdoption`.
- `server/src/prompt/memory/structured/edits.ts`: what a person's edit does, pure: `parseMemoryEdit`, `applyPageEdit`,
  `applyThreadEdit`, `MemoryEditRefusal`. The repairs, `applyEventRepair` and `flagUnsupportedSections`:
  [the lifecycle guide](structured-memory-lifecycle.md#files).
- `src/ts/process/structuredMemory.svelte.ts`: the reads `readStructuredMemoryContents`, `readStructuredMemoryRecord`,
  `readStructuredMemoryCoverage`, `readStructuredMemoryRuns`, `buildStructuredMemoryPackage`,
  `buildStructuredMemoryLog`, `readStructuredMemoryRevisions`, `readStructuredMemoryProjection`, which answer a
  `StructuredMemoryResult`; `editStructuredMemory`; the pure `renderMemoryPage`, `renderMemoryTimeline`, and
  `memoryPagePath`.

## Flows

### The read routes

All are `GET` under `STRUCTURED_MEMORY_PATH/:characterId/:chatId`, authenticated, rate-limited, and epoch-checked (412
`EpochMismatch`), with the check and every store read in one synchronous step. Ids are checked first (400).

- The chat's path answers the table of contents, `adoption`, `rebuild`, and `recordedLanguage`, which
  [the panel](structured-memory-read.md#the-memory-panel) reads; `/records/:kind/:id` answers one record of a
  `MEMORY_RECORD_KINDS` kind as stored. A missing chat or record is 404 with `reason` `chatGone` or `recordGone`.
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
- `/cost` answers [the cost preview](structured-memory-rebuild.md#the-cost-preview), with no record sent.
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

### The revert route

`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/revert`, `{ revision, pageId, historyId }`, capped at 64 KiB, answers
`StructuredMemoryRevertAnswer`. Its checks and order are the edit route's, so a running or stopped rebuild refuses it
409 `fenced`, and a write the swap would lose never happens. `revertChange` (`pages.ts`) undoes one writer's change:

- Only a writer's section entry can be undone. A page's creation, an `edit`, and a `revert` are 400, and an entry the
  bounded history lost is 404 `recordGone`. A repeat answers `reverted: false` through an empty change set.
- A `compact` is one change with the entry just before it, by place and event, never by event id alone: a repeated
  turn's scene rewrites share one. A `compact` whose patch left the history is 409 `reason: "superseded"`.
- A later entry of the heading that still stands is 409 `superseded`, so undoing goes newest first and never overwrites
  a later patch or a person's edit. A lock does not stop a revert.
- The section takes the first `before` of the change, with its marks, or goes when that is null. The entries gain
  `revertedBy: "user"`, and one `revert` entry keeps the text taken back, which the writer's next input reads.

`laterEvents`, which the notice counts, is the non-retracted events after the change's own in insertion order, 0 when it
is not listed.

### The restore route

`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/restore` gives an imported chat the records its file held, after the
whole shape check of `parseRestoredRecords`, and only when the chat holds no row. Its steps are in
[Chat files](structured-memory-lifecycle.md#chat-files).

### The Markdown package

`buildStructuredMemoryPackage` reads every round, renders in the tab, and answers `{ name, bytes }` for `downloadFile`.
A 409 restarts the read with nothing kept, 3 attempts in all, then refused `changed`. A 412 calls `epochMismatch` and
ends the read at once.

- The zip holds `timeline.md`, `threads.md`, and `pages/<type>/<title part> [<id part>].md`, one per page.
  [The import route](structured-memory-pages.md#the-import-route) reads it back. Threads come from `/threads` at the
  package's revision, each a `##` line and a `yaml` fence. Trash stays out.
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
   `memory_state` row. A stale empty write is still refused. `adoptionDeclined: true` names something once: on a chat
   that declined already it names nothing.
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

`projectChatMemory(events, messages)` is that for a whole chat, reading and export alike: `reconcileMemoryEvents` first,
so a changed source never reads as active ([Reconciliation](structured-memory-lifecycle.md#reconciliation-and-repairs)),
then events by their earliest source's position, because every reader takes `summaries` as chronological and `seq` puts
a re-record last. An event with no placed source goes last. The manifest is the newest message's with an `items` list in
`generationInfo.context`, empty when that send included nothing.

A tab's read overlays it:

- A structured chat: `memoryAlgorithmType` selects this algorithm, the chat has an event, and its stored `hypaV3Data`
  holds no summaries (`hypaV3DataHoldsSummaries`). A value with summaries means HypaV3 owns the field,
  [an adopted chat](structured-memory-lifecycle.md#adopting-hypav3-summaries) until a reset included, and an empty one,
  which opening the modal stores, owns nothing. The setting is one `json_extract` per read operation, never per chat, so
  under another algorithm a read touches no memory table, and a chat with no events answers as stored.
- Only `/api/resources` asks (`memoryProjection`, its GET and POST reads). `readChatSource` and a plain `readRefs` stay
  stored data: a job's scope, a memory task, the HypaV3 baseline, and `chatBaseline` must equal a stored read, and a
  checkpoint's capture reads the stored `meta`, so none of them meets a projection.
- A budgeted read charges the chats' `memory_events` bytes too. A projection that throws answers the chat as stored and
  warns once.
- The overlaid value is sealed: `structuredMemoryProjection`, `1:` and a non-cryptographic digest of the whole value
  with sorted keys. It tells a tab what the value is, and whether it is as a read gave it. It authorizes nothing.
- The value carries the memory revision it was read at (`structuredMemoryRevision`), inside the digest, so a whole read
  gives a tab its own baseline and the tab keeps no token of its own. Plugins see the field.

The tab's mirror holds it for plugins to read, unchanged, and nothing stores it:

- `sendChat` leaves a sealed value out of every `create`, `replace`, journal snapshot, and refusal retry; `projectChat`
  keeps it, so a `captureChatBaseline` diff stays natural. `prepareOp` drops one too, for what a stale tab or a
  recovered resend carries.
- `keepsHeldHypaV3Data` decides every write of the field, in `applyChatResult`, `createChat`, `installCharacterChats`,
  `replaceChat`, `installRecoveredChat`, and `setChatMeta`, and only the field drops: the rest of the write applies.
- An incoming sealed value is never taken. It is silent when intact, so a copy, a branch, an import, or an older read
  raises nothing, and a changed one raises the notice. An absent value keeps a projection in place.
- An unsealed value is refused with the notice while this algorithm is selected and the chat holds a projection, or
  nothing with summaries. It passes on a new chat, which has no records; on a chat with a real value; and under another
  algorithm, where it replaces a held projection and HypaV3 owns the chat from then on.
- The notice is `console.warn` plus one `alertToast` per chat until a reload
  (`structuredMemory.projectionWriteRefused`). `warnRefused` of the plugin API fits no refusal here: it discards the
  whole write.
- A job's copy and a patch's `meta` are stored data, so they leave a held projection in place (`keepsProjection`) unless
  they bring summaries. A whole read (`applyRemoteChat`, `installRead`) is authoritative: without the field, a held
  projection is gone. `HypaV3Modal` takes a sealed value as no data.

A plugin's read brings the held value up to the records (`refreshChatProjections`, `src/ts/plugins/apiV3/v3.svelte.ts`):

- `getChar`, `getCharacter`, `getCharacterFromIndex`, `getChatFromIndex`, and `getDatabase` with `characters` wait for
  it before they copy. Plugin writes and `getDatabase` without `characters` ask nothing. A send with no plugin read
  costs nothing.
- `POST STRUCTURED_MEMORY_PATH/revisions`, `{ chats }`, at most `MEMORY_REVISION_CHATS_MAX` and 256 KiB, answers
  `StructuredMemoryRevisionsAnswer` by position, with no message read: a token for what a whole read would project, or
  null. All of a read's chats go in one request, so a read with nothing new costs that alone.
- A `display` handler reads on every rendered row and streamed render, so a chat's check stands for
  `MEMORY_RECHECK_WINDOW_MS` from its answer, a failed one too. A read inside it takes the held value with no request
  and no wait, and a read that finds a check in flight joins it. A chat left past a cap keeps its moved revision: a
  later read finds it again, since the check compares the held token with the server's.
- `GET STRUCTURED_MEMORY_PATH/:characterId/:chatId/projection` answers `StructuredMemoryProjectionAnswer` for a chat
  whose token moved, sealed by `sealedMemoryProjection` against the stored messages. A null value is an answer: no
  projection, also under another algorithm, where `revision` is null too. Events over a read round are 413 before any
  message is read.
- Both routes are authenticated, rate-limited, and epoch-checked. A read fetches `MEMORY_PROJECTIONS_PER_READ` (8)
  projections at most, one by one, the chat it is about first. What is left stays as it is, and `rotatingWindow` gives
  the rest their turn on later reads, the chats past the revision cap too.
- The tab asks nothing under another algorithm, where a held projection goes at once, nor for a chat with a real value
  or not on the server yet. A chat a token answers null for loses a sealed value. A real value is never removed.
- `MEMORY_REFRESH_DEADLINE_MS` bounds the whole refresh, because a hook's read holds a send. A failed answer, a refusal,
  or the deadline leaves the held value, and the read answers with it.
- `installChatProjection` takes an answer only for a chat as `chatProjectionState` found it before the first await: the
  same chat object and value, the same owner, and a held revision of the same epoch and `seq`. It is the one change of
  the field that is no write. It skips `keepsHeldHypaV3Data`, which refuses every sealed value, and `changed`, which
  would dirty a queued create's journal. The token must be newer than one held at the same `seq`.

The upstream export (`projectUpstreamMemory`) applies the same rule, the setting from the snapshot's `ui` record, and
writes the value unsealed: a restore upstream and a re-import here both take plain HypaV3 data. `readSnapshotFile` keeps
the event rows, and a failed memory walk leaves `memoryEvents` null. A problem in the tables or in one event never stops
the export; those chats go as stored under `memory-unreadable`, and projected ones count as `memory-projected`.

### The reset

`POST .../reset-summaries`, with no body, answers `StructuredMemoryResetAnswer`. It takes a chat that has not declined,
holds an event of `ADOPTED_WRITER_RUN` or one holding `adoptedSummaries`, its lineage through
[a rebuild](structured-memory-rebuild.md#what-a-rebuild-keeps), and stores real summaries, the rule of the contents'
`resettable`, and writes a `meta` `unset` through `applyChanges`, so the feed publishes it; any other chat answers
`reset: false`. The server owns it because only it can check all that and the fence in one step. The tab writes nothing
back: an echoed `unset` moves the chat's revision and, since `meta` applies on a stale revision, deletes a newer value.
It takes `markChatStale` and `refreshStaleChat`, so a whole read overlays the projection, `hypaV3Owned` falls, and the
next plugin read past `MEMORY_RECHECK_WINDOW_MS` follows the records. Local work delays that read, and the mark survives
it.

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
[A rebuild's staged tables](structured-memory-rebuild.md#state) are not of the group: no walk reads them.

- `memory_state` (`chatSeq` primary key, `revision`, `adoptionDeclined`): one revision over all of a chat's records, and
  [a person's decline](structured-memory-lifecycle.md#the-adoption-choice), 0 or 1. A chat has no row until its first
  write, and an existing chat with no row is at revision 0. A decline is a write, so it moves the revision and a state
  row never sits at 0, which the snapshot walk refuses.
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

- The projection's return type and metric names come from `shared/memory.ts`. `HypaV3Modal.svelte` and
  `remapHypaV3Metrics` read each metric array independently, so an index may sit in two arrays.
- The persisted value `memoryAlgorithmType` is a plain string in `shared/database.ts`; `structuredMemory` selects ahead
  of the [selection chain](memory.md#selection-in-assembleprompt) that reads the flags, which [memory](memory.md) owns.
- The tables follow the [epoch rules](server-resources.md#epoch-and-response-rules) and the snapshot walk of
  [server resources](server-resources.md#snapshots-and-restore). `readSnapshotFile` walks them for the upstream export's
  projection, and alone among the walk's readers it does not stop on a problem in them (`memoryFailed`).
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
  ([Retraction and edits](structured-memory-lifecycle.md#retraction-and-edits)). A rebuild writes
  [staged tables of its own](structured-memory-rebuild.md#a-run), and its swap is one `write`.
- A route writes a closed edit applied to the record as stored ([the edit route](#the-edit-route)), or on
  [the inherit route](structured-memory-lifecycle.md#copies-and-branches) the records it builds from the source chat, or
  on [the adopt route](structured-memory-lifecycle.md#adopting-hypav3-summaries) the events it builds from the chat's
  summaries, or on the decline route a held chat's decline. [The restore route](#the-restore-route) and
  [the import route](structured-memory-pages.md#the-import-route) alone write records the tab sent: for a chat with no
  rows, after `parseRestoredRecords`.
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
- The stored `hypaV3Data` never holds a projection: the seal exists only in a tab's read and its mirror.
- Code owns grades: a draft carries scored axes, and only the stored `MemoryEvent` and `MemoryKnowledge` carry `grade`.

## Recipes

- A new persisted record field: add it to the shape in `shared/structuredMemory.ts`, optional unless every stored record
  will have it, give it [a check](structured-memory-lifecycle.md#recipes) in `structured/restore.ts`, and extend this
  guide's contract.
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
- The projection: `shared/structuredMemory.test.ts` for the seal, `structuredMemoryRoutes.test.ts` for the reads,
  `memoryStore.test.ts` for the write path and the budget charge, `upstreamExport.test.ts` for the export, each with
  `projectionHistory` from `tests/memoryFixtures.ts`; `src/ts/storage/tests/chatStore.test.ts`, `hostApi.test.ts`,
  `chatMemoryInherit.test.ts`, and `HypaV3Modal.fence.test.ts` for the tab; `hostApiMemory.test.ts` for a plugin read's
  refresh, on a scripted `authFetch`.
- `src/ts/process/structuredMemory.test.ts` runs in Node with `authFetch` scripted. Its splitters read a file only by
  metadata and line counts, as a reader must. It cannot use `testSupport.ts`: a `src/` test puts its imports under the
  root `tsconfig.json`, where the server routes do not type-check.
- `structured/edits.test.ts` drives the edit rules with plain records. `structuredMemoryRoutes.test.ts` drives the real
  fence on a real app, holding a task on a tokenizer read and a job on its runner.
- The adoption choice and the reset: `memoryStore.test.ts` for the decline and a real two-column table opened in place,
  `restoreStage.test.ts` for two-column snapshots, the column's values, and a checkpoint,
  `structuredMemoryRoutes.test.ts` for the routes and the feed, `memoryTasks.test.ts` and `memoryJobs.test.ts` for the
  hold, `assemble.test.ts` for a held send, `StructuredMemoryPanel.test.ts` for the choice and the reset, and
  `hostApiMemory.test.ts` for a plugin read after them.
- Focused command: `pnpm --silent test:agent structuredMemory memoryStore restoreStage backups edits`. No `slow` or
  `e2e` membership of its own; `backups.test.ts` holds other slow cases.
- Not tested: the types and limits themselves, which `pnpm check` covers only for the code that uses them.

## Known Hazards

### Limitations

- The `adoptionDeclined` column costs a rollback. A build from before it refuses a snapshot made by a later build whole
  (`invalid memory table columns`), even with no decline in it. It opens an upgraded live database and writes to it, but
  its own snapshots then hold the column too, so it refuses those as well. Their upstream export reads no memory events,
  so a chat that needs the projection goes out as `memory-unreadable`. It ignores a decline, and can record or adopt
  despite one. Decision: Structured Memory slice 6c, plan.
- The package holds no runs and no page history. Decision: Structured Memory slice 1d, plan.
- A round is bounded but the tab holds the whole package, and `zipSync` runs on the main thread. The table of contents
  has no budget of its own: it grows with the record count and the titles. Decision: Server Byte Budgets D2, archive.
- A held projection follows the memory revision, not the messages. A message edit or a send's manifest that changes
  reconciliation, the order, or `metrics` without moving the revision shows at the next whole read or the next move of
  the revision. Decision: Structured Memory slice 5g, plan.
- A `chatOutput` listener's payload copies the mirror with no refresh, so its `hypaV3Data` is what the tab holds. A
  listener that needs the newest calls `getChatFromIndex`.
- A chat past `MEMORY_REVISION_CHATS_MAX` waits its turn across reads, and one over the projection's byte cap keeps its
  last whole read's value.
- A page's creation cannot be reverted: that would delete the page and everything citing it. Decision: Structured Memory
  slice 7b, plan.
- Two reverts newest first and then a branch cut between them keep the older entry's `revertedBy`, though the cut
  brought its text back: the badge is wrong and the entry cannot be undone, and the writer is told nothing, since its
  list comes from the `revert` entries the cut dropped. Decision: Structured Memory slice 7b, plan.
- A change shows at the first read past a chat's `MEMORY_RECHECK_WINDOW_MS`, not the very next read. The refresh shares
  `authenticatedRouteLimiter`, and its cost is bounded per chat per tab: one `getChar` loop is one request a window, and
  a plugin walking chats through `getChatFromIndex` costs one request per chat per window.

### Gotchas

- The limits are starting values. Only `keyLinesPerEvent`, `pageCandidates`, `consecutiveFailures`, `axisMax`,
  `gradeMax`, `importantEventGrade`, and `dedupeSimilarity` are design numbers.
