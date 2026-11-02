# Structured Memory Rebuild: Runs, Staging, the Swap, Backfill, the Cost Preview

## Scope

- Owns a chat's rebuild and backfill: a run from its plan to its swap, the staged tables, what a rebuild keeps of a
  person's work, the lock a run puts on the chat, and the cost preview that rebuild, backfill, and record now share.
- Paths: `server/src/prompt/memory/structured/rebuild.ts`, the rebuild part of `server/src/prompt/memory/memoryTasks.ts`
  (`rebuildWork`, `commitOfRebuild`, `swapRebuild`, `noteRebuildStop`), the `rebuild` surface of
  `server/src/data/memoryStore.ts`, and the controls in `src/lib/Others/StructuredMemory/StructuredMemoryPanel.svelte`
  and `memoryRecordPress.ts`.
- See [structured memory](structured-memory.md) for records and a memory write, and [Active Plans](../plan/README.md)
  for the design and remaining work.
- Not here:
  - The writer's windows, runs, admission, and pages → [structured memory writer](structured-memory-writer.md).
  - The memory task service's queue, retention, and ends → [memory](memory.md#background-memory-task).
  - Reconciliation, retraction, adoption, and the hold → [structured memory lifecycle](structured-memory-lifecycle.md).
  - The rest of the panel → [structured memory read path](structured-memory-read.md#the-memory-panel).
  - Snapshots, the checkpoint tables, and transactions → [server resources](server-resources.md).

## Files

- `server/src/prompt/memory/structured/rebuild.ts`:
  - Pure: `rebuildPlan`, `rebuildSeed`, `rebuildWindow`, `rebuildChanges`.
  - `rebuildStore`, the staged records in the shape the writer takes. `readRecordSet`, a chat's records whole.
  - `memoryWorkCost`, the preview. `runMemoryRebuild`, the `memoryRebuild` command.
- `server/src/data/memoryStore.ts`: `createRecordSet`, the one write path of the live and the staged tables, and
  `createMemoryTables`' `rebuild`: `begin`, `readContents`, `readRecord`, `write`, `advance`, `status`, `plan`,
  `noteStop`, `noteSourceReplaced`, `swap`, `abandon`. `MEMORY_STAGED_TABLES` names the tables.
- `server/src/data/chatStore.ts`: `MEMORY_REBUILD_TABLES_SQL`, part of `CHAT_OPEN_SCHEMA_SQL`.
- `server/src/data/resourceStore.ts`: `store.memory.rebuild`, with `staged` the writer's memory and `rebuilding` the
  lock's read.
- `shared/structuredMemory.ts`: `STRUCTURED_MEMORY_REBUILD_MODES`, `StructuredMemoryRebuild`,
  `StructuredMemoryCostAnswer`, `StructuredMemoryAbandonAnswer`, `memoryCostTokens`, `MEMORY_CALL_OVERHEAD_TOKENS`,
  `structuredMemoryWriterLanguage`. `shared/jobs.ts`: the `memoryRebuild` command, `rebuild` on the task input and on
  `MemoryTaskService`.
- `server/src/routes/structuredMemory.ts`: `cost` and `rebuild/abandon`, and `rebuild` and `recordedLanguage` in the
  contents answer.
- `src/ts/process/structuredMemory.svelte.ts`: `readStructuredMemoryCost`, `abandonStructuredMemoryRebuild`.
  `memoryRecordPress.ts`: `pressMemoryRecord`, `pressMemoryRebuild`, `pressMemoryRebuildResume`.

## Flows

### A run

A run is a row, not a task, so it outlives a process. `rebuild` takes every confirmed turn and replaces what the
transcript can reproduce; `backfill` takes the turns no event cites and adds to the records.

1. Start: the `memoryRebuild` command, `{ mode, turns }`. A job, because it brings the tab's context, the chat's slot,
   and the whole of admission, and dispatched ahead of the preparation that refuses a group chat. `admitRecord` refuses
   a held chat, then come a memory model that needs the tab (`jobMemoryBlockingReason`, which a chained task cannot
   reach), no service, a live task, a run already there, and no window.
2. `begin` and `MemoryTasks.rebuild` are one synchronous step. A refused queue abandons what began.
3. Work: `rebuildWork` takes the plan once and goes on from the run's `cursor`. Each window reads the chat as stored
   (`rebuildWindow`, [screened](structured-memory-read.md#reply-screening) replies left out), so an edited message is
   read as it is now, and one with no message left moves the cursor with no call. The writer runs on `rebuildStore`,
   `manual: true`, unchanged but for `historical`.
4. Commit: `commitOfRebuild` checks the task's fence, the hold on the live records, then `commitWindow` on the staged
   store under the window's own last message, inclusive, so no stored ceiling can go missing. No chat is written, so
   there is no receipt and no revision for the tab's fence. A closing commit, one with a `recorded` run, moves the
   cursor in its own transaction, so progress and what it stands for land together.
5. Chain: after `maxWriterWindows` windows or half of `taskDeadlineMs`, the task queues its input again and ends `done`
   (`rebuildContinues`). `done` and `total` count the whole run. `startChecks` runs again, so a settings change stops a
   run at its next chained start, never mid-task.
6. A window that does not record ends the task with no retry and no more spending. `noteRebuildStop` keeps the reason
   and error on the row, because a terminal is retained only `terminalRetentionMs`. A person's pause, a chain,
   maintenance, and an epoch change keep none.
7. Resume: `{ resume: true }`, admitted the same way, with the settings as they stand. A failed window replays through
   [the writer's replay rule](structured-memory-writer.md#a-writer-run), which reads the staged runs.
8. At the cursor's end `swapRebuild`, in one synchronous step: the fence, the hold, `rebuildChanges`, `swap`, a task
   `done` (`rebuilt`). `nothingRecorded`, a run with no staged event, leaves everything and stops.

`DELETE /api/memory/tasks/...` is a pause: the run stays. `POST .../rebuild/abandon`, no body, is refused only while a
job holds the chat (409 `fenced`), cancels the task, and removes the run in one step, whatever the hold, the memory
toggle, or the stop reason. A chat with no run answers `abandoned: false` and cancels nothing.

### The plan

`rebuildPlan` works the windows out once, as message ids, so a step parses no event to find what is next.

- Confirmed messages run through the newest eligible reply, inclusive: a person's start confirms it, as record now does.
- `rebuild` leaves out messages a `retracted` event cites and no other event does. `retireRerecorded` also writes
  `retracted`, with no person involved, and its replacement cites the same messages, so those stay in.
- `backfill` leaves out `recordedMessages`, any status.
- A turn does not drop out for a recorded reply, unlike `confirmedWindows`: each lists what is left, and one with
  anything left counts. That takes the user messages an adopted chat's summaries left uncovered.
- Windows hold `turns` turns. The tab sends 1 under the `everyTurn` cadence and 2 under any other; the server checks
  only the value.

### What a rebuild keeps

The seed goes in at the start, so the writer works with it. `seededPage` keeps a page with a section marked `locked`,
`pinned`, `suppressed`, or `userCorrected`, or a person's grade, or a `contextMode` other than `auto` off the scene: its
identity, those sections, their headings' history, no links. A page a person merged or split (`reshaped`,
[the page tools](structured-memory-pages.md#what-a-merge-or-split-does-to-history)) seeds with all its sections and
history, because the arrangement is theirs. Its patches land on the same id and a lock refuses them by the usual rule.
Any other page is written anew, which is how a language change retitles it. A thread with no `openedBy`, which a person
added, is seeded too. A page in the trash stays live, untouched: the swap removes only ids of `contents.pages`.

No event is seeded. `rebuildChanges` decides at the swap, so a retraction during the run counts:

- A live event is replaced when it is not retracted, has a source, and every source's message is cited by a staged
  event. A replacement committed for everything it said. Any other stays in its table untouched: every retracted event,
  and a summary with no source, a source that is gone, disabled, or past the plan.
- Each staged event takes `pinned`, `suppressed`, and `userCorrected` from every standing live event it shares a message
  with, carried ones included, as a union, so rebuilding what survives of a suppressed event does not expose it.
- `adoptedSummaries` follows from an event of `ADOPTED_WRITER_RUN` or one holding it, in any status, so `resettable`
  holds through any number of rebuilds.
- A marked section goes back whole from the live page with its heading's history, a corrected one too although a patch
  may replace it in an ordinary run, so a history never sits under a body it does not lead to.
- Pages and threads not in the staged set go. A carried event may then name a page that is gone, and a `provenance` an
  event that is: dangling ids are legal.

`hypaV3Data` is never written. An adopted chat's stored summaries stay until
[the reset](structured-memory.md#the-reset), the projection stands aside as for any stored value, and a decline stays,
since `write` leaves it alone.

### Backfill

A backfill's windows lie before records that already exist, so it seeds the live pages verbatim and each window is a
historical write (`historical: { frozenPages }`):

- No repeat: `lastEvent` is null. A merge would append older sources after newer ones, which reconciliation reads
  `moved`.
- No scene rewrite and no thread change: `historicalAnalysis` empties them, and the run keeps what the model said.
- No patch on a frozen page: `withoutFrozenTargets` drops the target with a `frozenPage` warning. Creates stand, and
  later windows patch what the run made.

The swap writes the staged events and only the pages that are not live, so a frozen page stays as it stands, with any
flag it gained meanwhile, and a link a historical event would add to it goes.

### The swap

`swap` is one ordinary `write` on the live tables at the revision just read, so every check of a write runs before
anything is written, `createdRevision` follows the store's rule (a new id takes the committing revision, a kept one its
own), the scene rule holds, and the revision moves up by exactly one. The staged runs then join the live ones by their
text, and the staged rows and the run go. The rest of the write's parse is once in a run's life.

Only this moves what a chat reads. Staged writes publish nothing and touch no live table, so a plugin read fetches one
projection for the swap, and a run that fails or is abandoned leaves the live records and the revision as they were.

### During a run

The lock is the run row, not a task: job admission is the one chokepoint, and a send on a stopped run could write live
records through a gap run or a hand-off that the swap would lose. It lasts until a person resumes to the end or
abandons.

| During a run                              | What happens                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| Send, continue, command, `memoryRecord`   | Refused at admission beside `chatBusy`, 409 with text naming the panel              |
| Preview                                   | Allowed: it writes nothing                                                          |
| `memoryRebuild`                           | Reaches admission; refused unless it is a resume                                    |
| Panel edit, revert, adopt, decline, reset | 409 `fenced`, as are a restore and an inherit into the chat                         |
| Inherit from the chat, a chat file        | Allowed: they read live records                                                     |
| Checkpoint save                           | Allowed: it holds live records                                                      |
| Checkpoint load                           | Refused as `generating` (`loadLocked`), since `busy` also guards saves              |
| Chat deletion                             | Allowed: `invalidate` ends the task, the cascade takes the run and its rows         |
| Whole-chat replace                        | The task ends; `noteSourceReplaced` makes the run not resumable; abandon works      |
| Message edit or confirmed delete          | Allowed: `reconcileMessageChanges` reacts on the live records, then the staged ones |
| A window's source changed in flight       | `windowChanged`: the run stops, and a resume reads that window again                |
| Automatic task                            | `startChecks` ends it `skipped` (`memoryRebuilding`)                                |
| A live writer that got past admission     | `commitWindow` refuses `windowChanged`; `rebuildStore` answers that it holds no run |
| Algorithm switched away                   | `rebuilding` is false, so no lock; the run waits, and the panel returns with it     |
| Maintenance, shutdown, restart            | The task ends and the run stays. Nothing resumes it: no startup scan                |
| Snapshot restore                          | `DELETE FROM chats` cascades the run away                                           |

### The cost preview

`GET .../cost?mode=rebuild|backfill|record&turns=1|2[&through=<id>]` answers `StructuredMemoryCostAnswer` and writes
nothing. `calls` are windows, so it is the least a press spends: a window can add a patch call and compaction calls.
`record` counts the marked events and stops at `maxWriterWindows`. `estimatedTokens` is `memoryCostTokens`, the windows'
UTF-8 bytes over 3 plus `MEMORY_CALL_OVERHEAD_TOKENS` per call: analysis input only, an estimate, because a route has no
job scope to reach a real tokenizer.

Rebuild and backfill always ask. `pressMemoryRecord` asks at 2 calls or more, and when the read fails, naming the cost
as unknown. `recordTurns` takes the cadence for the windows.

### The language change

`openRun` stores `language` on each run, and the contents answer the newest `recorded` run's as `recordedLanguage`, one
record read. The panel compares it with `structuredMemoryWriterLanguage` and offers the rebuild with a line beside the
same buttons. It starts nothing. A chat with no such run has nothing to compare, so no line shows.

## State

- `memory_rebuilds`: one row per chat at most: `mode`, `revision` (the staged set's own counter), `sourceReplaced`,
  `cursor`, `total`, `plan` (message ids per window, written once), `reason`, `error`.
- `memory_staged_pages`, `_events`, `_threads`, `_runs`: the columns, uniqueness, and scene index of the live tables.
  `readContents` of the staged set always says declined, because a chat is held by its live records.
- `sourceReplaced` is a column, not a stored source generation: those live in memory and start over with a process, so
  `commitTransaction` sets it inside the replace's own transaction.
- `MemoryRun.language` and `MemoryEvent.adoptedSummaries` are optional fields of the JSON records, with no column.
- No record of a run leaves the staged tables before the swap. The task service holds nothing a run needs: a resume
  after a restart takes a fresh input.

## Coupling

- The staged tables are outside `MEMORY_TABLE_COLUMNS`, `walkMemorySnapshot`, `copyStagedMemory`, the checkpoint
  manifest, a chat file, and an inherit. `assertSnapshotHeader` and `memoryStateLayout` look only at the tables they
  name, and `writeValidatedStore` copies through explicit sinks, so a snapshot file carries the rows as bytes and no
  reader takes them as records. `PRAGMA integrity_check` still walks them.
- `createRecordSet` is `write`'s one path, so a rule added there holds for staged records too.
- `reconcileMessageChanges` calls the same reaction twice, so a staged event gains a `rerecord` mark or a retraction as
  a live one does, and a commit in flight gets `revisionConflict` and readmits.
- `commitWindow` reads `store.memory.rebuild.status` on the live path, and `rebuildStore` answers null to pass.
- The tab's fence covers a live task only, so the panel's read-only and the route's `fenced` both read the run.

## Invariants

- Only `swap` moves live records from a run. A staged write never touches a live table, and no reader but
  `store.memory.rebuild` reads a staged one.
- A rebuild writes no chat: no receipt, no `hypaV3Data`.
- A window that did not record spends nothing more until a person resumes.
- An event is replaced only by what cites everything it said.

## Recipes

- A new mark on a record: add it to `sectionMarked` or `swappedEvent`, and to `seededPage` if it is a page's.
- A new record kind: add it to `MEMORY_STAGED_TABLES` and `MEMORY_REBUILD_TABLES_SQL` beside `MEMORY_TABLES`, and decide
  in `rebuildChanges` whether a run replaces it.
- A new path that writes live memory: refuse it in `fenced` or at job admission, or a swap loses what it wrote.

## Tests

- `structured/rebuild.test.ts` drives the plan, the window, the seed, and `rebuildChanges` with plain records.
- `memoryStore.test.ts` drives the staged tables, the swap, a reopened file, and a snapshot taken mid-run on a real
  file.
- `memoryTasks.test.ts` drives a run on `createMemoryTasks` over a real store with the scripted provider, and a service
  built again over the same store stands in for a restart.
- `structuredMemoryRoutes.test.ts` drives the routes, the lock, the fence, the command's admission, and the reaction to
  a chat write on a real app.
- `StructuredMemoryPanel.test.ts` and `MemoryReceiptLine.svelte.test.ts` drive the controls and the press, and
  `src/ts/process/structuredMemory.test.ts` the client on a scripted `authFetch`.
- Focused command:
  `pnpm --silent test:agent rebuild memoryStore memoryTasks structuredMemoryRoutes StructuredMemoryPanel MemoryReceiptLine`.
  No `slow` or `e2e` membership of its own.
- Not tested: a real browser or a real provider. `MEMORY_CALL_OVERHEAD_TOKENS` and the 3-byte rule have no measurement.

## Known Hazards

### Limitations

- A stopped run keeps the lock until a person resumes or abandons, across restarts too. A chat whose panel is out of
  reach because the chat menu's memory entry is off, in a group, needs that setting turned on first. Decision:
  Structured Memory slice 6b, plan.
- A backfill adds events and new pages and leaves current state alone: existing pages, the scene, and threads learn
  nothing from it. A rebuild refreshes them. Decision: Structured Memory slice 6b, plan.
- A rebuild forgets reverts on sections with no mark: such a section is written anew, its history goes, and the writer
  can propose the change again. Decision: Structured Memory slice 7b, plan.
- A person's state change on a writer's thread does not survive a rebuild: only `openedBy` says whose a thread is.
  Decision: Structured Memory slice 6b, plan.
- Old receipts stay on their messages, with their event and run ids, as on a copied chat. Decision: Structured Memory
  slice 6b, plan.
- Seeded and carried text stays in its language, and a resume under another language leaves a mix. Decision: Structured
  Memory slice 6b, plan.
- A pin spreads to every staged event sharing a message, so an adopted summary's pin reaches all its turns' events.
  Decision: Structured Memory slice 6b, plan.
- The cost preview's `record` mode has no cadence, so `everyK` above 2 overstates calls. Decision: Structured Memory
  slice 6b, plan.
- A build from before these tables opens an upgraded database and ignores them: no lock, so a stopped run's later swap
  would lose what that build recorded. No snapshot refuses anything, and its restore drops them. Decision: Structured
  Memory slice 6b, plan.

### Gotchas

- A snapshot's size includes a stopped run's staged rows, prompts in `input` included, until the run ends.
- A rebuild's runs join the Log whole and are never pruned, so a long chat's rebuild adds about its prompts in storage,
  which every checkpoint save then reads ([Limitations](structured-memory-lifecycle.md#limitations)).
- `seq` is storage order, so after a backfill the last stored event is an old one: `admissionState` and `previousTitle`
  read it, and the next ordinary window can compare against it. The read path sorts by place.
- A swap holds the event loop for one parse of the chat's pages and events, in one synchronous step.
