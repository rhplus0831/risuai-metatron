# Structured Memory Lifecycle: Reconciliation, Retraction, Checkpoints, Copies

## Scope

- Owns what happens to a chat's `structuredMemory` records when the chat changes: reconciling events with the chat's
  messages and the repairs a person applies, retraction when messages are deleted and re-recording when they are edited,
  what a checkpoint holds and restores of the records, and what a copied or branched chat starts with.
- Paths: `server/src/prompt/memory/structured/{reconcile,inherit}.ts`, the repair and flagging rules of
  `server/src/prompt/memory/structured/edits.ts`, `src/ts/process/chatMemoryInherit.svelte.ts`, the reconciliation rules
  of `shared/structuredMemory.ts`, and the memory parts of `server/src/data/checkpointStore.ts`,
  `server/src/data/resourceStore.ts`, and `shared/chatCheckpoints.ts`.
- See [structured memory](structured-memory.md) for the records these rules act on, the tables and store, and the edit
  route that carries a repair, and [Active Plans](../plan/README.md) for the design and remaining work.
- Not here:
  - Record shapes and limits, the tables and store, the read routes, the edit route and the section and thread edits it
    applies, the Markdown package, a memory write, and the HypaV3 projection →
    [structured memory](structured-memory.md).
  - The writer's settings, windows, task kind, runs, analysis prompt, admission, and record now →
    [structured memory writer](structured-memory-writer.md).
  - The read path's lanes, card, manifest, and report, the receipts, and the memory panel in the tab →
    [structured memory read path](structured-memory-read.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](memory.md).
  - Checkpoint tables, snapshots, and the resource store's connection, epoch, and transactions →
    [server resources](server-resources.md).

## Files

- `shared/structuredMemory.ts`, the reconciliation part (the rest is in
  [structured memory](structured-memory.md#files)):
  - Reconciliation: `reconcileMemoryEvents`, `memoryAnchorState`, `memoryRerecordTarget`, `storedMemorySources`.
- `server/src/prompt/memory/structured/reconcile.ts`: the server's side: `reconcileEvents`, `retireRerecorded`,
  `withUnsupportedSections`, `automaticRerecords`, and `reconcileMessageChanges`.
- `server/src/prompt/memory/structured/edits.ts`, the repairs: `applyEventRepair`, `flagUnsupportedSections`. The rest
  is in [structured memory](structured-memory.md#files).
- `server/src/prompt/memory/structured/inherit.ts`: what a copied or branched chat starts with, pure:
  `inheritedRecords`, `MemoryInheritance`.
- `server/src/data/checkpointStore.ts` and `shared/chatCheckpoints.ts`: what a checkpoint holds of them,
  `CHECKPOINT_MEMORY_FIELD`, `CheckpointMemoryManifest`, and `readMemory` ([A checkpoint](#a-checkpoint)).
- `server/src/data/resourceStore.ts`, the checkpoint's part: `CheckpointTransaction.restoreMemory`. The rest is in
  [structured memory](structured-memory.md#files).
- `server/src/routes/structuredMemory.ts`: the inherit route and the repair half of the edit route
  ([Copies and branches](#copies-and-branches)). The rest is in [structured memory](structured-memory.md#files).
- `src/ts/process/structuredMemory.svelte.ts`: `inheritStructuredMemory`. The rest is in
  [structured memory](structured-memory.md#files).
- `src/ts/process/chatMemoryInherit.svelte.ts`: `createInheritingChat`, the wait and the notice. Its own file, because
  they read the chat store and the save loop, and `structuredMemory.svelte.ts` stays free of both.

## Flows

### Reconciliation and repairs

Reconciliation is a reading: `reconcileMemoryEvents` answers a copy, a send and the tab each take that copy, and no
stored row changes, so a message put back as it was makes its event whole again. The rule is in `shared/`, with `hashOf`
injected, because the tab runs it over the messages it holds.

An active event's reason is the first that holds:

1. `missing`: a source is unanchored, or its message is not in the list.
2. `changed`: a source's hash is not its message's.
3. Then the sources in list order, which is append order, since a repeat appends sources captured at a later time and a
   stored `index` says nothing across captures. Each id once, each against the one before: `moved` when its position is
   lower, `inserted` when the gap is larger than the stored gap, which counts only above 0.

What moves every source alike is not stale, because a chat that lost its first message would otherwise lose every event:
a message deleted or inserted before the event, or a whole block moved. Neither is a smaller gap, a disabled source, or
one source moved. A retracted event and one stored `stale` stay as they are.

An event's repairs go through [the edit route](structured-memory.md#the-edit-route) as
`{ kind: "event", eventId, repair }`:

- `retract`: `status: "retracted"`. It can be applied to any event but a retracted one, takes the mark with it, and
  flags the sections it leaves unsupported ([Retraction and edits](#retraction-and-edits)).
- `keep`: `keptState` holds `memoryAnchorState`, a string of each source's id, hash now, and position relative to the
  first present, and the event reads active while that state holds. `sources` stay as recorded, because a message that
  disappeared has no anchor to move to. The request names the state the person saw, because the memory revision says
  nothing of the messages, so another tab's edit cannot be accepted unseen.
- `rerecord`: sets `rerecord` and changes nothing else, so the old event stays until the new one commits. It is refused
  when `memoryRerecordTarget` is null: the newest message of the event a send reads is not a reply. The tab then presses
  record now, and [the writer's windows](structured-memory-writer.md#the-writers-windows) do the rest.

`keptState` and `rerecord` are fields of the stored record, so a checkpoint keeps them with its exact row text. Loading
one starts nothing: a restored mark is read as any other, by a press or
[the next automatic task](structured-memory-writer.md#the-writers-windows). A restored `keptState` holds while the
messages it named are back.

### Retraction and edits

A chat write reaches the records through a notice, not through the write itself, so a send never waits for it.

- `applyGroup` reports `ChatMessageChanges` of a by-id group: `retracted`, the ids a `remove` with `retract` deleted,
  and `rewritten`, the ids a write gave another `role` or `data`, which is what a source's hash reads. A job's write, a
  generation, a `generationInfo` or translation write, a replayed group, and a group with `create`, `replace`, or
  `delete` report nothing, and neither does an id the group inserted, or removed unmarked.
- `onMessagesChanged` delivers it after the commit through the queue of `onChatInvalidated`, never for a rollback. It is
  not one transaction with the write: a crash in between leaves the event reading `missing` or `changed`, which a repair
  answers.
- `reconcileMessageChanges` (subscribed in `app.ts`, with or without a task service) answers in one synchronous step at
  the revision it read. An event citing a `retracted` id is retracted by `applyEventRepair`, the panel's write. Any
  other event citing a `rewritten` id gains `rerecord` and nothing else, so it stays until
  [a re-record commits](structured-memory-writer.md#the-writer-task). It writes nothing when nothing is affected.
- It checks no fence, unlike the edit route: a running writer gets `revisionConflict` and admits from fresh records, or
  `windowChanged` when its source moved, and a re-record whose event no longer wants it is refused at its commit.

`withUnsupportedSections` is what every retraction's write passes through: the event route, `retireRerecorded`, and the
reaction. Over the events and pages as the change set leaves them, `flagUnsupportedSections` sets `unsupported` on a
section with `provenance` whose every id names a retracted event. An empty `provenance` does not count, and an id naming
no event is not retracted. The flag takes no history entry and no `updatedAt`, reverts nothing, and goes when the writer
changes the section, because that adds an active event to its `provenance`.

In the tab, `removeMessages` is a person's delete. Its checks throw at once, and under any other algorithm it removes at
once. With `structuredMemory` selected it pins the chat, reads the coverage, and asks with
`language.structuredMemory.removeRetracts` when an event that is not retracted cites a message. A no removes nothing,
and a yes puts `retract` on the `remove`. A failed read removes without the mark. After the wait it checks the chat's
owner and the locks again, and a message locked meanwhile refuses the delete.

`removeMessagesUnasked` asks nothing and carries no mark of its own: `/cut`, `/del`, and `runMultisend`. A recovered
draft passes the mark it holds. `applyChatResult` (a reroll, a script) and a server trigger's `remove` are unmarked too,
so what cites those messages reads `missing` and waits for the panel.

### A checkpoint

A checkpoint holds the chat's whole memory, all four kinds, runs included, so a loaded chat's Log matches its events.

- `save` reads each kind's rows in `seq` order (`rows`) and cuts them by the message page rule into content pages. A
  chunk's text is a JSON array of strings, each a row's `data` verbatim, so a restored record keeps its bytes.
- The page `fields` names under `CHECKPOINT_MEMORY_FIELD` lists each kind's chunks (`CheckpointMemoryManifest`), and
  `checkpointPageRefs` holds the manifest and the chunks. A save stores only the chunks that changed, and delete, prune,
  and a restore treat them as any other page.
- Every save writes the manifest, also for a chat with no records. A checkpoint without the key comes from before
  checkpoints held memory, and loading it leaves the records and the revision alone.
- `load` reads the texts beside `compose` (`readMemory`) and restores them in `after`, in the load's transaction, with
  `tx.restoreMemory` (`replace` of `createMemoryTables`). The safety checkpoint, taken in `before`, holds the memory
  from before the load.
- `replace` checks every row, deletes all four kinds, inserts the texts in order with fresh `seq`s, and moves the
  revision up by one, also with no records. It is not `write`: a record can be both held and restored, and an event
  keeps the `createdRevision` of its text. A stale write from before the load is refused by the new revision.
- `walkCheckpointSnapshot` checks the manifest and each chunk through `checkMemoryRow`, as a snapshot's rows and
  `replace` are checked, with duplicate ids and a second scene page caught across a checkpoint's chunks. A chunk is not
  held to the page limits: one record may pass them. Its sources are not compared with the checkpoint's messages.
- The walk has no counter to bound a `createdRevision` with, so `replace` refuses one past the new revision: a 400 at
  load that changes nothing. A live save never leaves one.

### Copies and branches

A chat copied from its row's options or branched from a message starts with the records its messages support, and
nothing from after the branch point reaches its prompt. A new, imported, plugin-made, or recovered chat inherits
nothing.

`createInheritingChat` stands in for `createChat` at those two sites. The action finishes as it did, and the rest runs
behind it, one attempt with no retry:

1. The create must reach the server, so `flushResources` runs in a mutation scope begun before `createChat`. The chat's
   key in `discarded` or `refused` ends it as a failure, and so does any error but the next one.
2. `GenerationBlockedError` is thrown for any deferred chat, also when this one could save, so it is no failure. The
   save loop goes on, and the tab waits for `chatHasUnackedWork` to fall, every 250 ms for 30 s at most. The wait proves
   nothing: the route's `chatGone` says whether the chat landed.
3. `inheritStructuredMemory` posts, on `createChat`'s answer: `createChat` may replace the id it was given.
4. A failure, or any refusal but `epoch`, which halts on its own, leaves the chat with no records and shows
   `structuredMemory.inherit.failed`. Every copy asks, because a chat can hold records under another algorithm, and only
   a user of this one reads the notice.

`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/inherit`, `{ sourceChatId }`, capped as an edit is, answers
`StructuredMemoryInheritAnswer`:

1. Ids and the body: 400, and a `sourceChatId` that is the chat itself too.
2. Epoch (412), then, with no await from here to the write, `fenced` on the new chat (409 `reason: "fenced"`). The
   source chat is not fenced: no writer of it can run inside this step.
3. The new chat's contents, 404 `chatGone`. A row of any kind, runs included, answers `inherited: false` and writes
   nothing, which is what a repeat finds.
4. The source chat's contents, 404 `chatGone`. With no page, event, or thread, `inherited: false`.
5. Every source page, event, and thread and both chats are read, `inheritedRecords` builds, and `store.memory.write`
   commits it at the contents' revision. Runs stay out: the Log starts empty, and coverage comes from the events'
   `sources`.

What `inheritedRecords` decides:

- A source maps by id, whatever its hash: ids repeat between a copy and its source, and reconciliation answers for a
  message that no longer matches. Else by position: both chats' messages there have ids and the same role and text, and
  the new chat's id is no source-chat message's, so a repeated "ok" never takes the copy of another. An unanchored
  source never maps.
- A mapped source keeps `hash` and `index`, and only `messageId` changes: reconciliation compares stored gaps, so a
  current position would make an `inserted` event read whole.
- An event with sources that all map crosses, with every field as stored but `createdRevision`, which the store stamps,
  and `rerecord`, a request about the source chat: on a copy it would spend a call nobody asked for, and the event still
  reads `changed` for the panel. That takes in `retracted` and `stale`: `recordedMessages` counts any status, so a
  retracted event left out would be recorded again. A remapped `keptState` only reads stale, which asks a person.
- An event that does not cross is behind when a source that did not map names a message the source chat holds and the
  new chat does not: what lies after the branch point. Any other stays out and undoes nothing, so a plain copy only
  loses dead evidence: with no behind event no page is rewound and no thread moves.
- A section is rewound, not flagged, because its body is replaced whole, `provenance` accumulates, and `shownSections`
  does not read `unsupported`. For each heading, the first `page.history` entry of a behind event is the cut: it and
  every later entry of that heading go, a person's edits included, and the section becomes its `before`. A `null`
  removes it, and a heading with no live section comes back. It keeps the live section's `locked` and trust flags, loses
  `disputed` and `unsupported`, and takes `updatedAt` from the cut.
- A page whose `heading: null` entry names a behind event stays out, and its id leaves the crossing pages' `links` and
  the crossing threads' `who`. The scene's `participants` have no history, so any behind event makes them `[]` for the
  writer to refill.
- Each section and each kept `before` keeps the crossing ids in `provenance` and the mapped `sources`. A section that
  still names a behind event after the rewind, because the history lost that change, gets `unsupported`, with its body
  kept, and so does one that had provenance and is left with no crossing event that is not `retracted`. No body is
  blanked and nothing is `suppressed`, which no edit clears.
- A thread opened by a behind event stays out. One a behind event moved, by name or as `closedBy`, takes the state the
  crossing events give it, replayed from `open` in contents order as `admitAnalysis` commits them, with `closedBy` only
  on an ended state. Any other stays as stored.

## State

- Stored records keep what was recorded, and reconciliation is a reading over them: `reconcileMemoryEvents` answers a
  copy, and no stored row changes ([Reconciliation and repairs](#reconciliation-and-repairs)).
- Two fields of a stored event are requests, not facts: `keptState`, which a person's keep sets, and `rerecord`, which
  the tab's repair or a rewritten message sets. Both are part of the record, so a checkpoint keeps them with its exact
  row text, and a copy keeps `keptState` and leaves `rerecord` behind.
- A retraction leaves the event stored with `status: "retracted"`, and sets `unsupported` on the sections it leaves
  without support. The flag is derived from `provenance` over the change set, not kept in its own table
  ([Retraction and edits](#retraction-and-edits)).
- A checkpoint holds a manifest of each kind's chunks beside its messages, and a chunk is the rows' `data` verbatim
  ([A checkpoint](#a-checkpoint)).

## Coupling

- A chat write reaches the records through `applyGroup`'s `ChatMessageChanges` and `onMessagesChanged`, which the chat
  store owns; [chat store](chat-store.md) holds the `retract` mark a `remove` carries.
- `reconcileMessageChanges` is subscribed in `app.ts`. It holds no fence, so a running writer meets it as
  `revisionConflict` or `windowChanged`, and a re-record is committed by
  [the writer task](structured-memory-writer.md#the-writer-task).
- The tab reads the reconciled copy for [the memory panel](structured-memory-read.md#the-memory-panel), and a send reads
  it for [the read path](structured-memory-read.md#the-read-path); both take the rule from `shared/`, with `hashOf`
  injected.
- A repair is a case of the edit route's closed union: [the edit route](structured-memory.md#the-edit-route) owns the
  fence, the revision check, and the answer.
- A checkpoint's memory follows the [checkpoint tables](server-resources.md#checkpoint-tables) and the load's
  transaction in [server resources](server-resources.md#snapshots-and-restore).
- The inherit route and `createInheritingChat` are reached from the chat list's copy and branch sites, and the store
  write is [a memory write](structured-memory.md#a-memory-write).

## Invariants

- Stored `status` is not what an event is worth now: anything that means "valid" reads a reconciled copy. `readContents`
  stays stored metadata.

## Recipes

- A new reconciliation reason: add it to the ordered list in `reconcileMemoryEvents`, where the first that holds wins,
  and read it only through the reconciled copy, never stored.
- A new repair: add it to the `repair` cases `applyEventRepair` applies, through
  [the edit route](structured-memory.md#the-edit-route), and send any retraction through `withUnsupportedSections`.
- A new field on a record a copy must carry: `inheritedRecords` keeps every field as stored but `createdRevision` and
  `rerecord`, so decide whether the new one is a fact about the source chat, as `rerecord` is.
- A new thing a checkpoint holds: it needs its own chunks in the manifest under `CHECKPOINT_MEMORY_FIELD`, a check in
  `walkCheckpointSnapshot`, and a place in `replace`, which restores all of a chat's memory in one transaction.

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
- Focused command: `pnpm --silent test:agent structuredMemory memoryStore reconcile chatCheckpoint inherit Inherit`. No
  `slow` or `e2e` membership of its own.

## Known Hazards

### Limitations

- `moved` and `inserted` are structural readings, not move detection. A single source or a whole block moved reads as
  whole, and a repeat appended after an earlier deletion can read as `inserted`, which a keep answers. The stored
  `index` holds no capture boundary. Decision: Structured Memory D4, plan.
- A confirmed delete lands after the coverage read and the question, so a send can start in that gap. Only a lock taken
  meanwhile refuses it; otherwise the reply can be built on the deleted message and the event retracted during the job.
  The read has no deadline of its own, so a hung read holds the delete with no question shown. Decision: Structured
  Memory slice 5b, plan.
- A mark outlives an edit that was put back: the event reads active, spends no call, and shows as waiting until a press,
  keep, or retract. A chat under a save refusal sends a whole `replace`, which loses `retract` and any `rewritten`, so
  the event reads `missing` or `changed` for the panel. Decision: Structured Memory slice 5b, plan.
- A checkpoint save reads and hashes every record's text in one synchronous step, however little changed, and runs are
  never pruned while each holds whole prompts. So a save's event-loop hold grows with the chat's memory, on every
  automatic checkpoint and every load's safety checkpoint: about 660 ms for 64 MB of runs on tmpfs. A load parses every
  record on top. Decision: Structured Memory slice 5d, plan.
- A tab closed before [the inherit](#copies-and-branches) posts leaves the new chat with no records and no notice:
  nothing retries it. Decision: Structured Memory slice 5c, plan.
- A send that reaches the new chat before the inherit is fenced or finds records, so that chat keeps a gap. Decision:
  Structured Memory slice 5c, plan.
- A copied or branched chat's receipts still read as they did, with no run behind them
  ([Gotchas](structured-memory-read.md#gotchas)). Decision: Structured Memory slice 5c, plan.
- A change the bounded history no longer holds cannot be rewound, so that section keeps its text, which can still reach
  the prompt, flagged `unsupported`. Provenance is bounded too: a change `sectionEvidence` also dropped leaves nothing
  to flag it by. A page whose `create` entry aged out crosses too. A person's edit after the branch point has no place
  in the message order, so it crosses unless it follows a behind change. Decision: Structured Memory slice 5c, plan.
