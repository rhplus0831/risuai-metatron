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
- `server/src/prompt/memory/structured/restore.ts`: what the restore route takes of a chat file, pure:
  `parseRestoredRecords`, `RestoredRecords`.
- `server/src/prompt/memory/structured/adopt.ts`: what a chat's HypaV3 summaries become, pure: `adoptedEvents`,
  `HypaV3Adoption`.
- `server/src/data/checkpointStore.ts` and `shared/chatCheckpoints.ts`: what a checkpoint holds of them,
  `CHECKPOINT_MEMORY_FIELD`, `CheckpointMemoryManifest`, and `readMemory` ([A checkpoint](#a-checkpoint)).
- `server/src/data/resourceStore.ts`, the checkpoint's part: `CheckpointTransaction.restoreMemory`. The rest is in
  [structured memory](structured-memory.md#files).
- `server/src/routes/structuredMemory.ts`: the inherit route ([Copies and branches](#copies-and-branches)), the restore
  route ([Chat files](#chat-files)), the adopt and decline routes
  ([Adopting HypaV3 summaries](#adopting-hypav3-summaries)), and the repair half of the edit route. The rest is in
  [structured memory](structured-memory.md#files).
- `src/ts/process/structuredMemory.svelte.ts`: `inheritStructuredMemory`, `readStructuredMemoryFile`,
  `exportChatMemory`, `chatFileMemory`, `restoreStructuredMemory`, `adoptStructuredMemory`, `declineStructuredMemory`,
  `resetStructuredMemorySummaries`. The rest is in [structured memory](structured-memory.md#files).
- `src/ts/process/chatMemoryInherit.svelte.ts`: `createInheritingChat`, `restoreChatMemory`, the wait and the notices.
  Its own file, because they read the chat store and the save loop, and `structuredMemory.svelte.ts` stays free of both.
- `src/ts/characters.ts`: `exportChat`, `exportAllChats`, and `importChat`'s `addChats` ([Chat files](#chat-files)).

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
nothing from after the branch point reaches its prompt. A new, plugin-made, or recovered chat inherits nothing, and an
imported one inherits nothing but [restores what its file holds](#chat-files).

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
4. The source chat's contents, 404 `chatGone`. With no page, event, or thread, `inherited: false`, and only a decline
   crosses.
5. Every source page, event, and thread and both chats are read, `inheritedRecords` builds, and `store.memory.write`
   commits it at the contents' revision, with a decline. `inherited` says whether records crossed. Runs stay out: the
   Log starts empty, and coverage comes from the events' `sources`.

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

### Chat files

An exported chat's JSON carries its pages, events, and threads, so an unchanged chat reads whole after a round trip,
even on another server. A run never goes in: it holds a whole prompt, and a file can be passed on. An imported chat
starts with an empty Log and no pause.

`risuChat` and `risuAllChats` stay `ver: 2` and gain an optional field beside `data`, `structuredMemory`: a list of
`StructuredMemoryFileEntry`, `{ chatId, pages, events, threads }`, one per chat that holds a page, event, or thread,
with `chatId` the chat's id in the file. It sits in the envelope, not in a chat, because older builds and upstream
ignore it there and `normalizeChatMeta` would store it in a chat.

`readStructuredMemoryFile` reads what an export takes:

- The contents come first, so a chat with no rows costs one request, and a chat with only runs no more. Otherwise
  `/package` and `/threads` rounds all name the contents' revision, and a 409 restarts the whole collection with nothing
  kept, 3 attempts in all.
- An initial `chatGone` on the contents means no records: a chat the server refused may not be on it, and
  `RefusedDataBanner` exports from there. `chatGone` after the contents showed records is a refusal.
- `readWithDeadline` bounds the whole read at 60 s and its signal goes through `readAnswer`, because `authFetch` has no
  deadline and this read must not hold an export that needs no server otherwise. The deadline is a `failed` result.

`exportChat` reads for JSON and for HTML, whose `.idat` holds the chat JSON the HTML import reads but no records. It
reads after `ensureChatLoaded` and before it copies the chat: a chat newer than its records leaves a turn uncovered,
while records newer than the chat would put pages ahead of their messages. `exportAllChats` reads one chat at a time
from the detached chats. `exportChatMemory` then changes the exported copy only:

- `hypaV3Data` goes when it is sealed (`isSealedHypaV3Data`), on every path, the failed read included: a sealed value is
  a [projection](structured-memory.md#the-hypav3-projection), which a tab can hold also after another algorithm was
  selected, and it never reaches a file. An unsealed value stays whatever the selected algorithm: a chat can hold real
  summaries beside records, and they are live after a switch back to HypaV3.
- `generationInfo.memory` goes from every message when the chat holds a row of any kind, runs included, since a chat
  with only failed runs can hold paused receipts. A receipt is a display copy of a run, and runs do not cross: the panel
  would offer Resume on an empty Log, and a failed restore would show `recorded`. The rest of `generationInfo` stays,
  and hashes do not read it.

A failed read, or any refusal but the initial `chatGone`, writes the chat with no records at all, never a part of them,
and leaves the receipts and a real `hypaV3Data` as they are. The download goes on, because an export works with the
server unreachable and the banner is the last rescue of refused data.
`structuredMemory.memoryFile.exportedWithoutRecords` takes the place of `successExport`, since `alertError` and
`alertNormal` each queue a dialog. HTML shows no notice: it holds no records anyway. `exportAllChats` names how many
chats went without, and one chat's failure stops no other.

`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/restore`, `{ pages, events, threads }`, capped by
`RouteLimits.memoryRestoreBodyBytes`, default `MEMORY_RESTORE_BODY_BYTES` (32 MiB, because a stored record alone may
reach one round), answers `StructuredMemoryRestoreAnswer`:

1. Ids and the body: 400, and 413 past the cap.
2. `parseRestoredRecords`: 400 for anything of another shape.
3. Epoch (412), then, with no await from here to the write, `fenced` (409 `reason: "fenced"`).
4. The chat's contents, 404 `chatGone`. A row of any kind, runs included, or a request with no record answers
   `restored: false` and writes nothing, which is what a repeat finds.
5. `store.memory.write` at the contents' revision, built from the three checked lists, so no `runs` or `remove` gets
   through. A store refusal is a 400: an invalid id, a second scene page, a record past the store's size limit.

What `parseRestoredRecords` decides:

- A file can come from anyone, the store leaves a record's shape to its callers, and readers dereference nested fields
  unguarded, so it checks the whole nested shape of `MemoryPage`, `MemoryEvent`, and `MemoryThread`. A source is a
  string `messageId` with a string `hash` and a safe-integer `index`, or with both null.
- It refuses nothing on `STRUCTURED_MEMORY_LIMITS`, because genuine records pass them: 16 `close` ids after admission,
  33 sections after an inherit, a person's 4,000-character scene section, unbounded event `sources`. It never truncates.
- No reference has to resolve: `writerRun` names a run that is not there, and inherited records keep dangling ids.
  Sources are not compared with the chat's messages, because reconciliation answers for that.
- Unknown fields stay, so a newer file loses nothing. `createdRevision` goes, since the store stamps it, and so does
  `rerecord`, a request about the source chat, as on a copy. `keptState` stays.

In the tab only `importChat`'s `ver: 2` branch reaches records:

- `chatFileMemory` reads the list: anything but an array counts as none, and of two entries for one id the first wins.
  Each chat takes its entry by its file id, before `chat.id = v4()`. A file without the field imports as it always did,
  with no request.
- `addChats` begins a mutation scope before the first `createChat` and calls `restoreChatMemory` in a `finally`, so the
  chats already created get their restore when a later `createChat` throws.
- Behind the action, unawaited, one chat at a time with its own `try`: `createSettled`, the wait of
  [a copy](#copies-and-branches), then `restoreStructuredMemory` on `createChat`'s answered id.
- `restored: false`, or any refusal but `epoch`, which halts on its own, is a failure. One notice names the failed
  chats, whatever the selected algorithm: a file that holds records was meant to restore them, unlike a copy, which asks
  for every chat. A 413 is `tooLarge`, with its own words naming the limit.
- The notice says the records could not be confirmed as restored and the earlier messages may not be covered, never that
  nothing was restored: a response can be lost after a commit, and a send can start on the chat first.

### Adopting HypaV3 summaries

A chat with HypaV3 summaries and no records can take them as events, with no model call and no cost to preview.
`StructuredMemoryPanel` offers it ([the memory panel](structured-memory-read.md#the-memory-panel)), and
`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/adopt`, with no body, answers `StructuredMemoryAdoptAnswer`.

The route decides, whatever the tab offered:

- It reads the chat through `readChatSource`, never an overlaid or tab-sent value, so a projection cannot be adopted,
  and `adoptedEvents` also refuses a sealed value. No body is read, so the checks and the write are one synchronous
  step: the epoch, the fence (409 `fenced`), the contents, the build, then `store.memory.write`.
- A chat with a page, event, or thread answers `adopted: 0`, which is what a repeat finds, and so does a chat that
  declined or has nothing to adopt. None writes. Runs do not count, unlike [a copy](#copies-and-branches) and
  [a chat file](#chat-files): a failed writer run leaves a row and no record, so counting one would refuse adoption for
  good, and the fence holds off a live one.
- It writes events only. `hypaV3Data` and the chat row stay as they were, and adopting adds no run to the Log. Failed
  runs already there stay, and so does a pause they caused. `writerRun` is `ADOPTED_WRITER_RUN`, which names no run.
  Timeline's line says "originally": a later run can merge into the last adopted event, which keeps that `writerRun`.

`adoptedEvents` builds one event for each summary with text, in stored order:

- `summary` is the stored text whole. `eventSummaryChars` binds the writer's answer, while a covering event lets its
  messages leave the prompt and the value can be reset later, so a cut would lose text for good.
- `title` is the first sentence, clamped to `eventTitleChars`. `isImportant` becomes `pinned`. There are no
  participants, and `categoryId` and `tags` stay behind in `hypaV3Data`.
- Sources are `chatMemos`, each id once, by current position, with hashes of the messages as stored, so a new event
  reads whole. A `null` memo is dropped: `assemble.ts` builds the greeting with no memo, so a first summary normally
  holds one, and calling it missing would make that summary stale in most chats.
- A cited message that is gone is a `MemoryUnanchoredSource`, and its event is stored `stale` with
  `staleReason: "missing"`. So is an event left with no source, because [reconciliation](#reconciliation-and-repairs)
  reads an event with no sources as whole. Neither moves until a repair does.

After it:

- `recordedMessages` reads sources in any status, so adopted turns count as recorded and the writer takes only later
  ones. `coveredMessages` takes active events only, so a stale one lets no message leave the prompt.
- The stored value holds summaries, so `overlayMemoryProjection` and the upstream export stand aside, and plugins read
  the real `hypaV3Data` until a reset empties it. From then on they read
  [the projection](structured-memory.md#the-hypav3-projection), `pinned` as `isImportant`.
- The next send can embed the new events, as any send embeds its records. Only adopting is free of model calls.

### The adoption choice

A chat with no page, event, or thread and no decline, whose stored `hypaV3Data` `adoptedEvents` would make an event of,
is held (`adoptionHold`, runs not counting), so blank summaries hold nothing. Nothing records until a person adopts or
declines in the panel ([the writer](structured-memory-writer.md#a-writer-run) enforces it), which keeps D11's one owner.
While held the projection stands aside as for any stored summaries, so a plugin reads the real value.

`POST .../decline`, with no body, answers `StructuredMemoryDeclineAnswer`. Its checks and write are one step, as for
adopting. Only a held chat writes `adoptionDeclined`, one-way, moving the memory revision; a real value in a tab stays,
because a plugin read never asks about one and `readProjectionRevisions` answers null for it. Any other chat answers
`declined: false`. The writer then starts from the oldest turn.

Where a decline goes: a snapshot carries it. A checkpoint load leaves it, because `replace` sets only the revision, so
it outlives a load from before it. An inherit carries it, with no record or none supported too, since the copy holds the
same summaries. A chat file drops it, because a file can be passed on, so an imported chat with summaries and no records
is held. The restore route leaves one in place.

A reset of an adopted chat's stored summaries is [its own step](structured-memory.md#the-reset), because the projection
takes over from it.

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
- The restore route is reached from `importChat` alone, [a memory write](structured-memory.md#a-memory-write) too, and
  is the one route that writes records the tab sent ([Invariants](structured-memory.md#invariants)).
- The adopt route is reached from the panel alone, and
  [the writer's windows](structured-memory-writer.md#the-writers-windows) read what it writes as recorded through
  `sources`, so an event's shape is the only contract between them.
- A chat file and [the HypaV3 projection](structured-memory.md#the-hypav3-projection): an exported copy drops
  `hypaV3Data` by the seal alone (`exportChatMemory`), so the projection a tab's read overlays must stay sealed, and an
  unsealed one would be exported as real summaries. An import of an older file that holds a sealed value drops it in
  `createChat`.

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
- A chat's records over [the restore](#chat-files)'s body cap cannot be restored, and the export does not warn: the file
  holds them and the import shows the size notice. Decision: Structured Memory slice 5f, plan.
- HTML, TXT, and jsonl chat files carry no records, so a chat imported from one starts with a coverage gap. Decision:
  Structured Memory slice 5f, plan.
- [Adoption](#adopting-hypav3-summaries) refuses a chat that holds a record, such as one recorded before the hold or a
  summary written after the first record: nothing merges them with events. Decision: Structured Memory slice 6a, plan.
- Under `doNotSummarizeUserMessage` a summary cites only replies, so an adopted chat's user messages stay uncovered
  until [a backfill](structured-memory-rebuild.md#backfill). Decision: Structured Memory slice 6a, plan.
- A declined chat is never reset, since its summaries have no other copy, so its plugins keep reading them without any
  later event. Selecting HypaV3 and using its modal is the way out. A held chat's send has no summaries or card, so its
  older history trims until the choice. Decision: Structured Memory slice 6c, plan.
- An adopted summary over the card's budget is left out whole (`budget`) while its messages leave the prompt and only
  its flow title goes. Retrieval embeds the whole text, so a provider that refuses it fails similarity for that send,
  with no participants to fall back on, and compaction never touches events. Decision: Structured Memory slice 6a, plan.
- `pinned` selects nothing in any lane, so an adopted important summary is no longer sent every time. Decision:
  Structured Memory slice 6a, plan.
- A stored-stale adopted event has narrower repairs. A keep reads active, but with no source present retrieval leaves it
  out as `not-relevant`. A re-record needs the newest cited message a send reads to be a reply. An edit of a surviving
  source spends no automatic call, because the event reads `missing`, not `changed`. A copy drops an event with an
  unanchored source or none, kept or not. Decision: Structured Memory slice 6a, plan.
- An all-chats export reads the chats first and their records after, so a chat can be older than its records. Each
  chat's read has its own 60 s bound, so a server that hangs by then holds the file a minute per chat. Decision:
  Structured Memory slice 5f, plan.
- A send that reaches an imported chat before its restore leaves it unrestored: the chat then holds rows, or is fenced,
  and the notice shows. A tab closed before the restore posts leaves it the same with no notice: nothing retries it.
  Decision: Structured Memory slice 5f, plan.
