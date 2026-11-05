# Structured Memory Lifecycle: Reconciliation, Retraction, Checkpoints, Copies

## Scope

- Owns what happens to a chat's `structuredMemory` records when the chat changes: reconciling events with the chat's
  messages and the repairs a person applies, retraction when messages are deleted and re-recording when they are edited,
  what a checkpoint holds and restores of the records, what a copied or branched chat starts with, what a chat file
  carries and an imported chat restores, and how a chat's HypaV3 summaries are adopted.
- Paths: `server/src/prompt/memory/structured/{reconcile,inherit,restore,adopt}.ts`, the repair and flagging rules of
  `server/src/prompt/memory/structured/edits.ts`, `src/ts/process/chatMemoryInherit.svelte.ts`, the reconciliation rules
  of `shared/structuredMemory.ts`, the memory parts of `server/src/data/checkpointStore.ts`,
  `server/src/data/resourceStore.ts`, `shared/chatCheckpoints.ts`, and `src/ts/characters.ts`.
- See [structured memory](records.md) for the records these rules act on, the tables and store, and the edit route that
  carries a repair, and [the archive](../../archived-plan/README.md) for the design and remaining work.
- Not here:
  - The records, the projection and the reset, the writer, the read path, the rebuild, and the page tools →
    [the area README](README.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](../memory.md).
  - Checkpoint tables, snapshots, and the resource store's connection, epoch, and transactions →
    [server resources](../server-resources.md).

## Files

- `shared/structuredMemory.ts`: shared reconciliation rules; `reconcileMemoryEvents`, `memoryAnchorState`,
  `memoryRerecordTarget`, `storedMemorySources`. Other parts: [records](records.md#files).
- `server/src/prompt/memory/structured/reconcile.ts`: server reconciliation and reactions; `reconcileEvents`,
  `retireRerecorded`, `withUnsupportedSections`, `automaticRerecords`, `reconcileMessageChanges`.
- `server/src/prompt/memory/structured/edits.ts`: event repairs and section flags; `applyEventRepair`,
  `flagUnsupportedSections`. Other edits: [records](records.md#files).
- `server/src/prompt/memory/structured/inherit.ts`: copy and branch record builder; `inheritedRecords`,
  `MemoryInheritance`.
- `server/src/prompt/memory/structured/restore.ts`: chat-file record admission; `parseRestoredRecords`,
  `RestoredRecords`.
- `server/src/prompt/memory/structured/adopt.ts`: HypaV3 summary conversion; `adoptedEvents`, `HypaV3Adoption`.
- `shared/chatCheckpoints.ts`: checkpoint memory manifest contract; `CHECKPOINT_MEMORY_FIELD`,
  `CheckpointMemoryManifest`.
- `server/src/data/checkpointStore.ts`: memory capture and snapshot admission; `createCheckpointTables`, `save`,
  `readMemory`, `walkCheckpointSnapshot`, `checkMemoryChunk`. Owner: [server resources](../server-resources.md).
- `server/src/data/resourceStore.ts`: checkpoint transaction access and message notices;
  `CheckpointTransaction.restoreMemory`, `onMessagesChanged`.
- `server/src/data/memoryStore.ts`: record storage and replacement; `rows`, `replace`. Owner: [records](records.md).
- `server/src/data/checkpointService.ts`: checkpoint save/load orchestration; `createCheckpointService`, `load`.
- `server/src/data/chatStore.ts`: message-change classification; `applyGroup`, `ChatMessageChanges`.
- `server/src/app.ts`: message-notice subscription; `onMessagesChanged`, `reconcileMessageChanges`.
- `server/src/routes/structuredMemory.ts`: lifecycle HTTP routes; `registerStructuredMemoryRoutes` header's `inherit`,
  `restore`, `adopt`, `decline`, and the event-repair part of `edits`.
- `src/ts/process/structuredMemory.svelte.ts`: the tab's lifecycle client and file adapter; `inheritStructuredMemory`,
  `restoreStructuredMemory`, `adoptStructuredMemory`, `declineStructuredMemory`, `readStructuredMemoryFile`,
  `exportChatMemory`, `chatFileMemory`. `resetStructuredMemorySummaries` belongs to
  [projection](projection.md#the-reset).
- `src/ts/process/chatMemoryInherit.svelte.ts`: creates' memory hand-off; `createInheritingChat`, `createSettled`,
  `restoreChatMemory`.
- `src/ts/storage/chatStore.svelte.ts`: delete confirmation and marks; `removeMessages`, `removeAfterAsking`,
  `removeMessagesUnasked`. Owner: [chat store](../chat-store.md).
- `src/ts/characters.ts`: chat-file orchestration; `exportChat`, `exportAllChats`, `importChat`, `addChats`.
- `server/src/prompt/memory/structured/writer.ts`: adoption hold shared with the routes; `adoptionHold`,
  `chatAdoptionHold`. Owner: [writer](writer.md).

## Flows

### Reconciliation and repairs

A send takes `reconcileEvents`' copy against stored messages; the tab takes `reconcileMemoryEvents`' copy with its own
`hashOf`. Neither changes stored rows: putting a message back can make its event whole again. Read the shared module's
`reconcileMemoryEvents`, `staleReasonOf`, `memoryAnchorState` and `memoryRerecordTarget` for reason precedence, anchor
comparisons and repair eligibility.

The panel sends event repairs through [the edit route](records.md#the-edit-route) to `applyEventRepair`. Retraction also
passes through `withUnsupportedSections` before the store write. Keep acknowledges the message state seen in the tab,
since messages can change without moving the memory revision. Re-record marks the old event, then the tab presses record
now; [the writer's commit](writer.md#the-writer-task) swaps it for the replacement. Until then, even after a failed run,
the old event and mark stay. `applyEventRepair` owns no-op and refusal rules.

Loading a checkpoint starts no work. A press can take a restored `rerecord` mark;
[an automatic task](writer.md#the-writers-windows) takes only the changed-source marks `automaticRerecords` admits. See
[State](#state) for the two persisted repair fields.

### Retraction and edits

A chat write reaches memory through a post-commit notice:

1. `server/src/data/chatStore.ts`'s `applyGroup` reports `ChatMessageChanges`: a marked `remove` supplies `retracted`
   ids; a person's change of `role` or `data` supplies `rewritten` ids. Read those entrypoints for excluded writes.
2. `onMessagesChanged` delivers after commit through the `onChatInvalidated` queue, never for rollback.
   `server/src/app.ts` subscribes `reconcileMessageChanges` with or without a task service. At the read revision, the
   reaction retracts events citing `retracted` ids through `applyEventRepair`, or marks rewritten evidence for
   re-recording.
3. This reaction, the edit route and `retireRerecorded` pass retractions through `withUnsupportedSections` before
   `store.memory.write`. It supplies `flagUnsupportedSections` with the change set's resulting events and pages. A
   writer's later `changeSection` clears the flag while adding its active event to the section's provenance.

This is separate from the chat transaction: a crash between them leaves `missing` or `changed` for a repair. The
reaction runs in the write's turn and awaits no writer task. It holds no fence, so a running writer meets
`revisionConflict` and admits from fresh records, or `windowChanged`; retirement refuses a re-record whose old event no
longer wants it.

In the tab, `removeMessages` checks immediately and, outside this algorithm, removes immediately. Under this algorithm,
`removeAfterAsking` pins the chat and reads coverage before asking `language.structuredMemory.removeRetracts` when a
non-retracted event cites a message. Declining cancels the delete; confirming carries `retract` through the save. A
failed read allows an unmarked delete. After the wait it rechecks the owner and locks; a newly locked message refuses
it.

`removeMessagesUnasked` is unasked and unmarked for `/cut`, `/del` and `runMultisend`; a recovered draft can pass an
earlier mark. `applyChatResult` (rerolls and scripts) and server-trigger removes are unmarked too, leaving `missing` for
a panel repair.

### A checkpoint

A checkpoint captures all four kinds, runs included, so the loaded Log matches its events. `save` takes
`memoryStore.ts`'s `rows`; the checkpoint module header defines verbatim chunks. `fields` names their manifest under
`CHECKPOINT_MEMORY_FIELD` (`CheckpointMemoryManifest`); `checkpointPageRefs` includes both. Only changed chunks need new
pages, treated like other pages by delete, prune and snapshot restore.

1. `server/src/data/checkpointService.ts`'s `load` reads `compose` and `readMemory`. Every new save writes the manifest,
   even empty; its absence identifies a legacy checkpoint whose load leaves memory and its revision alone.
2. The service's `before` callback saves the pre-load memory in a safety checkpoint; `after` calls `tx.restoreMemory`
   when memory was captured. Safety capture, chat replacement and memory restore share one `applyChanges` transaction.
3. `CheckpointTransaction.restoreMemory` delegates to `memoryStore.ts`'s `replace`, whose comment defines row checks and
   replacement. All four kinds restore, preserving `createdRevision`; the revision moves up by one even with no records,
   refusing a write based on the pre-load revision.

A running writer is stopped before that: `load` takes the chat's summary writer lease (`acquireSummaryWriter`,
`"checkpoint-load"`), which ends the task as `cancelled` (`writerLease`), and the commit invalidates retained task input
([summary writers](../memory.md#summary-writers)).

`walkCheckpointSnapshot` and `checkMemoryChunk` own manifest/chunk admission, including checks across chunks. The walk
has no memory revision counter: a crafted future `createdRevision` can pass it but fail `replace` at load, a 400 with no
change, safety checkpoint included. A live save never creates one.

### Copies and branches

Copying from a chat row's options or branching from a message uses `createInheritingChat`. The server's
`inheritedRecords` maps evidence and rewinds page history; its header and helpers define which records cross. Retained
history and reshaped pages limit the rewind ([Limitations](#limitations));
`server/src/prompt/memory/structured/retrieve.ts`'s `shownSections` does not hide `unsupported` text. A new, plugin-made
or recovered chat inherits nothing; an import instead [restores its file](#chat-files).

1. `createInheritingChat` begins a mutation scope before `createChat` and returns its answer while memory work runs
   behind the action. `createSettled` calls `flushResources`; a discarded/refused create or save error fails it.
   `GenerationBlockedError` can concern another chat, so it waits for `chatHasUnackedWork`, bounded by 30 s, while the
   save loop continues. This proves no acknowledgment: the route's `chatGone` remains authoritative.
2. `inheritStructuredMemory` posts `{ sourceChatId }` to `POST .../inherit` on `createChat`'s answered id, which can
   differ from the input. After body admission the route checks the epoch and target fence, reads both chats and source
   records, builds through `inheritedRecords`, and calls `store.memory.write` at the target's read revision. This is
   synchronous, so a source writer cannot enter between the reads; only the target needs a fence.
3. Any target row, runs included, prevents inheritance. The source's decline crosses with the records, even with none
   supported or none to build; `inherited` reports records only. Runs stay behind: the new Log is empty and coverage
   comes from event sources. The route header owns empty/repeat answers and HTTP refusals.

One attempt, no retry. Every copy asks, even under another algorithm; only this algorithm shows
`structuredMemory.inherit.failed` on failure or non-`epoch` refusal. `epoch` halts with its own notice. A failed
response leaves inheritance unconfirmed; it can be lost after commit. Closing the tab before the request leaves no
records or notice.

### Chat files

JSON chat files carry pages, events and threads, preserving coverage on an unchanged round trip even to another server.
Runs stay behind because they hold whole prompts and the file can be shared; the imported Log starts empty, with no
pause.

`risuChat` and `risuAllChats` remain `ver: 2`. Beside `data`, optional `structuredMemory` lists
`StructuredMemoryFileEntry`, `{ chatId, pages, events, threads }`, for chats with records, by the file's chat id. This
belongs in the envelope: older builds and upstream ignore it there, whereas `normalizeChatMeta` would store it inside a
chat.

Export crosses `src/ts/characters.ts`, the memory client and the routes:

1. `exportChat` calls `ensureChatLoaded`, then `readStructuredMemoryFile`, then copies the chat. A newer chat leaves a
   turn uncovered; newer records put pages ahead of their messages. `exportAllChats` takes detached chats first, then
   reads each chat's records serially, so its records can be newer than the chats.
2. The client collects `/package` and `/threads` at the contents' revision. `readStructuredMemoryFile` owns retries, the
   60 s whole-read bound (`readWithDeadline`, since `authFetch` has none), and initial `chatGone` handling for
   `RefusedDataBanner`.
3. `exportChatMemory` changes only the exported copy. Its comment defines receipt removal and the seal-only rule that
   keeps [projections](projection.md#the-hypav3-projection) out of files under any algorithm or read outcome, while real
   summaries stay.

A failed read or refusal other than initial `chatGone` exports no records, keeps receipts and real summaries, and lets
the download proceed: an unreachable server must not prevent rescue of refused data. One dialog,
`structuredMemory.memoryFile.exportedWithoutRecords`, replaces `successExport` because `alertError` and `alertNormal`
each queue one. `exportAllChats` names the failed-chat count and continues past failures. `exportChat` also reads for
HTML-file export, whose `.idat` carries the chat JSON alone; HTML shows no memory notice. HTML, TXT and jsonl carry no
records.

Import crosses the file adapter, chat creation, save loop and restore route:

1. Only `importChat`'s `ver: 2` JSON branch supplies records. `chatFileMemory` indexes the envelope; its comment owns
   malformed-list and duplicate-id handling. Lookup uses the file id before `chat.id = v4()`. No entry means no request.
2. `addChats` starts a mutation scope before the first `createChat` and calls `restoreChatMemory` in `finally`, so
   already-created chats get their restore even if a later create throws. Behind the action, each independently passes
   `createSettled`'s wait, then `restoreStructuredMemory` uses the answered create id.
3. `POST .../restore` takes `{ pages, events, threads }` through `parseRestoredRecords`, whose header owns nested-shape
   checks, field preservation and exclusions. After admission, epoch/fence checks, the empty-target check and
   `store.memory.write` share one synchronous step at the read revision. Any target row, runs included, or an empty
   request answers `restored: false`. Only the three checked lists reach the store, which can still refuse invalid ids,
   a second scene page or an oversized record with 400.

The body cap is `RouteLimits.memoryRestoreBodyBytes`, default `MEMORY_RESTORE_BODY_BYTES` (32 MiB), since a stored
record can reach one read round. A 413 is `tooLarge` with a size notice. `restored: false` or a non-`epoch` refusal
fails; `epoch` halts with its own notice. `restoreChatMemory` names failed chats under any algorithm, each failure
leaving the others to continue.

The notice says restoration is unconfirmed and earlier messages may not be covered: an answer can be lost after commit,
and a send reaching the chat first can leave it fenced or holding rows. Tab closure before the request leaves no records
or notice; no retry.

### Adopting HypaV3 summaries

`StructuredMemoryPanel` offers the choice ([the memory panel](read.md#the-memory-panel)); its press calls
`adoptStructuredMemory`, then bodyless `POST .../adopt`. The route reads `readChatSource`, builds events through
`adoptedEvents` and commits through `store.memory.write` in one synchronous epoch/fence/read/build/write step. Neither a
tab-sent value nor an overlaid projection is adopted; the builder also refuses sealed values. No model is called and
there is no cost to preview. The route header owns `StructuredMemoryAdoptAnswer` and no-op/refusal rules; the builder's
header owns summary conversion.

Unlike inherit/restore, adoption permits existing runs: a failed run must not bar it, and the fence excludes a live one.
It writes only events, leaving the chat's `hypaV3Data`, failed runs and their pause in place, with no new Log run.
`ADOPTED_WRITER_RUN` names no run; Timeline says “originally” because a later writer can merge into the last adopted
event and keep that marker.

`recordedMessages` counts sources in any status, so the writer leaves adopted turns recorded. `coveredMessages` takes
only active, unsuppressed events, so stale ones remove no messages from the prompt. A later send can embed these events;
only adopting is free of model calls. Stored summaries keep `overlayMemoryProjection` and upstream projection aside
until a reset; plugins then read [the projection](projection.md#the-hypav3-projection), `pinned` as `isImportant`.

### The adoption choice

`adoptionHold` holds a chat with no page, event, thread or decline when `adoptedEvents` could build from its stored
summaries; runs do not count and blank summaries hold nothing. The panel offers adopt or decline.
[The writer](writer.md#a-writer-run) records nothing until the choice; a send's `adoptionHeld` prevents the gap question
and task hand-off. This keeps one memory owner per chat. While real summaries remain, the projection stands aside and
plugins read them.

The panel calls `declineStructuredMemory`, then bodyless `POST .../decline`. In one checked synchronous write, only a
held chat sets one-way `adoptionDeclined` and moves the memory revision; any other answers `declined: false`
(`StructuredMemoryDeclineAnswer`). The writer then starts from the oldest turn. A tab's real value stays: plugin reads
never ask about one and `readProjectionRevisions` answers null for it.

Where a decline goes: snapshots carry it; a checkpoint's `replace` leaves it in memory state, even loading a pre-decline
checkpoint. Inherit carries it with no records or none supported too, since the copy holds the same summaries. Chat
files drop it for sharing, so a summary-only import is held for a new choice; the restore route preserves an existing
decline. Resetting an adopted chat's summaries is [a separate step](projection.md#the-reset), after which the projection
takes over.

## State

- Stored records keep what was recorded, and reconciliation is a reading over them: `reconcileMemoryEvents` answers a
  copy, and no stored row changes ([Reconciliation and repairs](#reconciliation-and-repairs)).
- Two fields of a stored event are requests, not facts: `keptState`, which a person's keep sets, and `rerecord`, which
  the tab's repair or a rewritten message sets. Both are part of the record, so a checkpoint keeps them with its exact
  row text, and a copy or a chat file's restore keeps `keptState` and leaves `rerecord` behind.
- A retraction leaves the event stored with `status: "retracted"`, and sets `unsupported` on the sections it leaves
  without support. The flag is derived from `provenance` over the change set, not kept in its own table
  ([Retraction and edits](#retraction-and-edits)).
- A checkpoint holds a manifest of each kind's chunks beside its messages, and a chunk is the rows' `data` verbatim
  ([A checkpoint](#a-checkpoint)).

## Coupling

- A chat write reaches the records through `applyGroup`'s `ChatMessageChanges` and `onMessagesChanged`, which the chat
  store owns; [chat store](../chat-store.md) holds the `retract` mark a `remove` carries.
- `reconcileMessageChanges` is subscribed in `app.ts`. It holds no fence, so a running writer meets it as
  `revisionConflict` or `windowChanged`, and a re-record is committed by [the writer task](writer.md#the-writer-task).
- The tab reads the reconciled copy for [the memory panel](read.md#the-memory-panel), and a send reads it for
  [the read path](read.md#the-read-path); both take the rule from `shared/`, with `hashOf` injected.
- A repair is a case of the edit route's closed union: [the edit route](records.md#the-edit-route) owns the fence, the
  revision check, and the answer.
- A checkpoint's memory follows the [checkpoint tables](../server-resources.md#checkpoint-tables) and the load's
  transaction in [server resources](../server-resources.md#chat-writes-and-checkpoints).
- The inherit route and `createInheritingChat` are reached from the chat list's copy and branch sites, and the store
  write is [a memory write](records.md#a-memory-write).
- The restore route is reached from `importChat` alone, [a memory write](records.md#a-memory-write) too, and, alongside
  [package import](pages.md#the-import-route), writes records the tab sent ([Invariants](records.md#invariants)).
- The adopt route is reached from the panel alone, and [the writer's windows](writer.md#the-writers-windows) read what
  it writes as recorded through `sources`, so an event's shape is the only contract between them.
- A chat file and [the HypaV3 projection](projection.md#the-hypav3-projection): an exported copy drops `hypaV3Data` by
  the seal alone (`exportChatMemory`), so the projection a tab's read overlays must stay sealed, and an unsealed one
  would be exported as real summaries. An import of an older file that holds a sealed value drops it in `createChat`.

## Invariants

- Stored `status` is not what an event is worth now: anything that means "valid" reads a reconciled copy. `readContents`
  stays stored metadata.

## Recipes

- A new reconciliation reason: add it to the ordered list in `reconcileMemoryEvents`, where the first that holds wins,
  and read it only through the reconciled copy, never stored.
- A new repair: add it to the `repair` cases `applyEventRepair` applies, through
  [the edit route](records.md#the-edit-route), and send any retraction through `withUnsupportedSections`.
- A new field on a record a copy must carry: `inheritedRecords` keeps every field as stored but `createdRevision` and
  `rerecord`, so decide whether the new one is a fact about the source chat, as `rerecord` is.
- A new thing a checkpoint holds: it needs its own chunks in the manifest under `CHECKPOINT_MEMORY_FIELD`, a check in
  `walkCheckpointSnapshot`, and a place in `replace`, which restores all of a chat's memory in one transaction.
- A new field on a record a chat file carries: `parseRestoredRecords`' checks cover every field of the type, so
  `pnpm check` asks for one. Make it `optional` unless every file ever written holds the field.

## Tests

- `structured/reconcile.test.ts` and `shared/structuredMemory.test.ts` drive reconciliation with plain records, and
  `src/ts/process/structuredMemory.test.ts` pins the tab's hash to a literal from `messageSourceHash`.
- Retraction runs on real stores: `structuredMemoryRoutes.test.ts` through the batch and edit routes,
  `memoryStore.test.ts` the notice, `memoryTasks.test.ts` and `memoryJobs.test.ts` the re-records. `chatStore.test.ts`,
  `command.test.ts`, and `RecoveryDrafts.test.ts` drive the question and the mark in the tab.
- `chatCheckpoints.test.ts` and `chatCheckpointRoutes.test.ts` drive a checkpoint's memory through the checkpoint
  service; `restoreStage.test.ts` forges its manifests and chunks.
- `structured/inherit.test.ts` drives the build with plain records and an injected `hashOf`,
  `structuredMemoryRoutes.test.ts` the inherit route on a real app, and `chatMemoryInherit.test.ts` the tab's wait on
  fake timers, with the save loop and `authFetch` scripted. `Chat.test.ts` and `SideChatList.test.ts` drive the two
  sites.
- `structured/restore.test.ts` drives the shape check with plain records, `structuredMemoryRoutes.test.ts` the restore
  route and a round trip onto a second store on real apps, and `structuredMemory.test.ts` the file read with `authFetch`
  scripted. `chatMemoryInherit.test.ts` drives the restore's wait.
- `structured/adopt.test.ts` drives the build with plain records and an injected `hashOf`,
  `structuredMemoryRoutes.test.ts` the adopt route and the read after it on a real app, and
  `StructuredMemoryPanel.test.ts` the offer and the press.
- `charactersCapture.test.ts` and `charactersImportChat.test.ts` run the export and the import on
  `storeBackedServer.ts`, which has no memory route: its 500 reads as a failed memory read, so an export there takes the
  notice unless the test answers the route, as `serveMemory` does.
- Focused command: `pnpm --silent test:agent structuredMemory memoryStore reconcile chatCheckpoint inherit Inherit` and,
  for chat files, `restore.test charactersCapture charactersImportChat`, and for adoption,
  `adopt.test structuredMemoryRoutes StructuredMemoryPanel`. No `slow` or `e2e` membership of its own.

## Known Hazards

### Limitations

- `moved` and `inserted` are structural readings, not move detection. A single source or a whole block moved reads as
  whole, and a repeat appended after an earlier deletion can read as `inserted`, which a keep answers. The stored
  `index` holds no capture boundary. Decision: Structured Memory D4, archive.
- A confirmed delete lands after the coverage read and the question, so a send can start in that gap. Only a lock taken
  meanwhile refuses it; otherwise the reply can be built on the deleted message and the event retracted during the job.
  The read has no deadline of its own, so a hung read holds the delete with no question shown. Decision: Structured
  Memory slice 5b, archive.
- A mark outlives an edit that was put back: the event reads active, spends no call, and shows as waiting until a press
  or retract; a keep of an already-active event is a no-op. A chat under a save refusal sends a whole `replace`, which
  loses `retract` and any `rewritten`, so the event reads `missing` or `changed` for the panel. Decision: Structured
  Memory slice 5b, archive.
- A checkpoint save reads and hashes every record's text in one synchronous step, however little changed, and runs are
  never pruned while each holds whole prompts. So a save's event-loop hold grows with the chat's memory, on every
  automatic checkpoint and every load's safety checkpoint:
  [about 500 ms for 79 MB of runs](../../audit/structured-memory-2026-11-03.md). A load parses every record on top.
  Decision: Structured Memory slice 5d, archive.
- A tab closed before [the inherit](#copies-and-branches) posts leaves the new chat with no records and no notice:
  nothing retries it. Decision: Structured Memory slice 5c, archive.
- A send that reaches the new chat before the inherit is fenced or finds records, so that chat keeps a gap. Decision:
  Structured Memory slice 5c, archive.
- A copied or branched chat's receipts still read as they did, with no run behind them ([Gotchas](read.md#gotchas)).
  Decision: Structured Memory slice 5c, archive.
- A change the bounded history no longer holds cannot be rewound, so that section keeps its text, which can still reach
  the prompt, flagged `unsupported`. Provenance is bounded too: a change `sectionEvidence` also dropped leaves nothing
  to flag it by. A page whose `create` entry aged out crosses too. A person's edit after the branch point has no place
  in the message order, so it crosses unless it follows a behind change. Decision: Structured Memory slice 5c, archive.
- A chat's records over [the restore](#chat-files)'s body cap cannot be restored, and the export does not warn: the file
  holds them and the import shows the size notice. Decision: Structured Memory slice 5f, archive.
- HTML, TXT, and jsonl chat files carry no records, so a chat imported from one starts with a coverage gap. Decision:
  Structured Memory slice 5f, archive.
- [Adoption](#adopting-hypav3-summaries) refuses a chat that holds a record, such as one recorded before the hold or a
  summary written after the first record: nothing merges them with events. Decision: Structured Memory slice 6a,
  archive.
- Under `doNotSummarizeUserMessage` a summary cites only replies, so an adopted chat's user messages stay uncovered
  until [a backfill](rebuild.md#backfill). Decision: Structured Memory slice 6a, archive.
- A declined chat is never reset, since its summaries have no other copy, so its plugins keep reading them without any
  later event. Selecting HypaV3 and using its modal is the way out. A held chat's send has no summaries or card, so its
  older history trims until the choice. Decision: Structured Memory slice 6c, archive.
- An adopted summary over the card's budget is left out whole (`budget`) while its messages leave the prompt and only
  its flow title goes. Retrieval embeds the whole text, so a provider that refuses it fails similarity for that send,
  with no participants to fall back on, and compaction never touches events. Decision: Structured Memory slice 6a,
  archive.
- `pinned` selects nothing in any lane, so an adopted important summary is no longer sent every time. Decision:
  Structured Memory slice 6a, archive.
- A stored-stale adopted event has narrower repairs. A keep reads active, but with no source present retrieval leaves it
  out as `not-relevant`. A re-record needs the newest cited message a send reads to be a reply. An edit of a surviving
  source spends no automatic call, because the event reads `missing`, not `changed`. A copy drops an event with an
  unanchored source or none, kept or not. Decision: Structured Memory slice 6a, archive.
- An all-chats export reads the chats first and their records after, so a chat can be older than its records. Each
  chat's read has its own 60 s bound, so a server that hangs by then holds the file a minute per chat. Decision:
  Structured Memory slice 5f, archive.
- A send that reaches an imported chat before its restore leaves it unrestored: the chat then holds rows, or is fenced,
  and the notice shows. A tab closed before the restore posts leaves it the same with no notice: nothing retries it.
  Decision: Structured Memory slice 5f, archive.
