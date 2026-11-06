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
  `retireRerecorded`, `withRetractedEvidence`, `automaticRerecords`, `reconcileMessageChanges`.
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
`hashOf`. Neither changes stored rows, so restoring a message can make its event whole again. The shared and server
module headers own reason precedence, evidence reconciliation and repair eligibility.

The panel sends repairs through [the edit route](records.md#the-edit-route). A `rerecord` mark only requests a writer
run: the old event remains until [the writer commit](writer.md#the-writer-task) replaces it, and a replacement older
than later evidence uses the [historical path](writer.md#a-writer-run).

Loading a checkpoint starts no work: a restored `rerecord` mark [waits for a press](writer.md#the-writers-windows). See
[State](#state) for the two persisted repair fields.

### Retraction and edits

`applyGroup` classifies confirmed removals as `retracted` and edits to `role`, `data` or `saying` as `rewritten`;
`onMessagesChanged` delivers the notice after the chat transaction commits. `app.ts` wires it to
`reconcileMessageChanges`, whose header owns the record reaction and thread/section effects. Memory reconciliation is a
separate write: a crash between the chat commit and its notice leaves the event readable as `missing` or `changed` for a
later repair.

For a user-confirmed delete, `removeAfterAsking` checks coverage and asks before carrying `retract` through the save;
the chat store guide owns its save and lock checks. `/cut`, `/del`, `runMultisend`, rerolls, scripts, server triggers
and recovered drafts can remove messages without that mark, leaving `missing` for panel repair.

### A checkpoint

A checkpoint stores all four record kinds, including runs, as chunks named by `CheckpointMemoryManifest`; the checkpoint
store header owns the chunk format and reuse. New checkpoints write a manifest even when empty. A legacy checkpoint
without one leaves memory and its revision alone on load.

`checkpointService.load` captures a safety checkpoint, replaces the chat and restores memory through one `applyChanges`
transaction. `tx.restoreMemory` restores the four kinds and moves the memory revision once, even for an empty restore.
The [server resources guide](../server-resources.md#chat-writes-and-checkpoints) owns the transaction; the
[checkpoint tables](../server-resources.md#checkpoint-tables) section owns snapshot validation. A crafted future
`createdRevision` can pass the snapshot walk but fail the load's `replace` with 400; no change commits, including the
safety checkpoint.

`load` takes `acquireSummaryWriter(..., "checkpoint-load")`, cancelling a running writer with `writerLease` and
invalidating retained task input ([summary writers](../memory.md#summary-writers)).

### Copies and branches

Copying from a chat row or branching from a message calls `createInheritingChat`; plugin-made and recovered chats do not
inherit. The tab posts `{ sourceChatId }` to `POST .../inherit` after `createChat` answers, using its returned id. Its
module header owns the save-loop wait and failure notice; this is one attempt, so closing the tab before the request can
leave a created chat without memory. An inherited section still marked `unsupported` can reach the prompt:
`retrieve.ts`'s `shownSections` does not hide it.

The route checks the epoch and target fence, reads both chats and source records, builds via `inheritedRecords`, then
writes the target synchronously at its read revision; only the target needs a fence because a source writer cannot enter
between reads. The builder's header owns source-to-target evidence mapping and page-history rewind. Any target row, runs
included, prevents inheritance. Runs stay behind, so receipts are stripped from the copied chat and coverage comes from
event sources. A decline crosses with the records; `inherited` reports record transfer only. For refusal and repeat
answers, see the route header. Imports instead [restore their file](#chat-files).

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

The [memory panel](read.md#the-memory-panel) calls `adoptStructuredMemory`, then bodyless `POST .../adopt`. In one
synchronous step, the route reads stored `hypaV3Data`, builds events and writes them; a sealed projection is never
adopted. Adoption uses no model; the `adopt.ts` header owns summary conversion, and the route header owns hold, repeat
and refusal rules. It permits existing runs but fences a live one and writes only events, leaving summaries and failed
runs untouched; `ADOPTED_WRITER_RUN` names no run.

Adopted sources count as recorded to the writer, while send coverage still requires an active, unsuppressed event. A
later send can therefore process them through the normal read path; adoption alone makes no model call. Stored summaries
keep the [HypaV3 projection](projection.md#the-hypav3-projection) aside until reset.

### The adoption choice

`adoptionHold` and the adoption route share eligibility: a chat with no page, event, thread or decline waits only while
stored summaries can become events. Runs do not count; blank summaries hold nothing. The panel offers adopt or decline.
The held chat gets no send gap question or writer hand-off ([writer](writer.md#the-writer-task)), keeping one memory
owner until the choice. While real summaries remain, the projection stands aside and plugins read them.

Decline calls bodyless `POST .../decline`; only a held chat sets `adoptionDeclined` and moves the memory revision. The
writer then starts from the oldest turn. A real HypaV3 value is not subject to this choice: plugin reads never ask about
it and `readProjectionRevisions` answers null.

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

- `chatStore.ts` owns message-change classification and the delete mark; [chat store](../chat-store.md) owns their write
  protocol. `reconcileMessageChanges` runs after commit without a fence; a concurrent writer retries at its boundary.
- The tab and send both read the shared reconciliation rule ([panel](read.md#the-memory-panel),
  [read path](read.md#the-read-path)); [records](records.md#the-edit-route) owns repair admission and memory revisions.
- Checkpoint chunks and the load transaction are owned by
  [server resources](../server-resources.md#chat-writes-and-checkpoints).
- Chat-file `hypaV3Data` handling follows the [projection seal](projection.md#the-hypav3-projection); lifecycle owns
  which records the file carries and how restore admits them.
- Copy, restore, and adoption all write through [the memory store](records.md#a-memory-write); their source records come
  from `inherit`, `restore`, or `adopt`, respectively.

## Invariants

- Stored `status` is not what an event is worth now: anything that means "valid" reads a reconciled copy. `readContents`
  stays stored metadata.

## Recipes

- A new reconciliation reason: add it to the ordered list in `reconcileMemoryEvents`, where the first that holds wins,
  and read it only through the reconciled copy, never stored.
- A new repair: add it to the `repair` cases `applyEventRepair` applies, through
  [the edit route](records.md#the-edit-route), and send any retraction through `withRetractedEvidence`.
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
