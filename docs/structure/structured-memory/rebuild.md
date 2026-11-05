# Structured Memory Rebuild: Runs, Staging, the Swap, Backfill, the Cost Preview

## Scope

- Owns a chat's rebuild and backfill: a run from its plan to its swap, the staged tables, what a rebuild keeps of a
  person's work, the lock a run puts on the chat, and the cost preview that rebuild, backfill, and record now share.
- Paths: `server/src/prompt/memory/structured/rebuild.ts`, the rebuild part of `server/src/prompt/memory/memoryTasks.ts`
  (`rebuildWork`, `commitOfRebuild`, `swapRebuild`, `noteRebuildStop`), the `rebuild` surface of
  `server/src/data/memoryStore.ts`, and the controls in `src/lib/Others/StructuredMemory/StructuredMemoryPanel.svelte`
  and `memoryRecordPress.ts`.
- See [structured memory](records.md) for records and a memory write, and [the archive](../../archived-plan/README.md)
  for the design and remaining work.
- Not here:
  - The records, the projection, the writer, the lifecycle, the read path with the rest of the panel, and the page tools
    → [the area README](README.md).
  - The memory task service's queue, retention, and ends → [memory](../memory.md#background-memory-task).
  - Snapshots, the checkpoint tables, and transactions → [server resources](../server-resources.md).

## Files

- `server/src/prompt/memory/structured/rebuild.ts`: rebuild planning, preservation, staging adapter, preview and
  command; `rebuildPlan`, `rebuildSeed`, `seededPage`, `rebuildWindow`, `rebuildChanges`, `swappedEvent`,
  `readRecordSet`, `rebuildStore`, `memoryWorkCost`, `runMemoryRebuild`.
- `server/src/prompt/memory/memoryTasks.ts`: rebuild task execution and chaining; `createMemoryTasks`' rebuild comments,
  `rebuildWork`, `rebuildOpen`, `commitOfRebuild`, `swapRebuild`, `noteRebuildStop`.
- `server/src/data/memoryStore.ts`: rebuild tables and their shared write path; `MEMORY_STAGED_TABLES`,
  `createRecordSet`, `createMemoryTables`' `rebuild`: `begin`, `readContents`, `readRecord`, `write`, `advance`,
  `status`, `plan`, `noteStop`, `noteSourceReplaced`, `swap`, `abandon`. Other surfaces: [records](records.md).
- `server/src/data/chatStore.ts`: rebuild schema; `MEMORY_REBUILD_TABLES_SQL`, `CHAT_OPEN_SCHEMA_SQL`.
- `server/src/data/resourceStore.ts`: rebuild transaction boundary and staged writer access; `store.memory.rebuild`,
  `staged`, `rebuilding`. Owner: [server resources](../server-resources.md).
- `shared/structuredMemory.ts`: rebuild and cost contracts; `STRUCTURED_MEMORY_REBUILD_MODES`,
  `StructuredMemoryRebuild`, `StructuredMemoryCostAnswer`, `StructuredMemoryAbandonAnswer`, `memoryCostTokens`,
  `MEMORY_CALL_OVERHEAD_TOKENS`, `structuredMemoryWriterLanguage`.
- `shared/jobs.ts`: rebuild command and task contracts; `GenerationCommand`'s `memoryRebuild`,
  `StructuredMemoryTaskInput` and `MemoryTaskService`'s `rebuild`.
- `server/src/routes/structuredMemory.ts`: rebuild HTTP surface; `registerStructuredMemoryRoutes`' `cost` and
  `rebuild/abandon` comments, contents' `rebuild` and `recordedLanguage`.
- `src/ts/process/structuredMemory.svelte.ts`: the tab's cost and abandon client; `readStructuredMemoryCost`,
  `abandonStructuredMemoryRebuild`.
- `src/lib/Others/StructuredMemory/memoryRecordPress.ts`: command presses and confirmation; `pressMemoryRecord`,
  `pressMemoryRebuild`, `pressMemoryRebuildResume`, `recordTurns`.
- `src/lib/Others/StructuredMemory/StructuredMemoryPanel.svelte`: rebuild controls and contents refresh; component
  contract, `rebuild`, `readOnly`, `languageChange`. Other controls: [read](read.md#the-memory-panel).
- `server/src/jobs/commandRunner.ts`: rebuild dispatch; `createGenerationRunner`, `prepare`.
- `server/src/jobs/generationJobs.ts`: run-based job lock; `rebuildLocks`, `memoryRebuilding`.
- `server/src/app.ts`: rebuild route and checkpoint-load fences; `fenced`, `chatHeld`, `loadLocked`.
- `server/src/prompt/memory/structured/recordJob.ts`: shared command admission; `admitRecord`. Owner:
  [writer](writer.md).
- `server/src/prompt/memory/structured/reconcile.ts`: rebuild's message-change reaction; `reconcileMessageChanges`.
  Owner: [lifecycle](lifecycle.md).
- `server/src/prompt/memory/structured/writer.ts`: staged writer, replay and historical writes;
  `createStructuredWriter`, `commitWindow`, `openRun`, `admissionState`, `historicalAnalysis`. Owner:
  [writer](writer.md).
- `server/src/prompt/memory/structured/pages.ts`: historical page-target filtering; `withoutFrozenTargets`. Owner:
  [pages](pages.md).

## Flows

### A run

A run is a persisted row, outliving tasks and processes. The Structured Memory writer task kind works it through
`rebuildWork`, with records in its own staged tables until [the one live write](#the-swap).

1. The tab's `pressMemoryRebuild` or `pressMemoryRebuildResume` sends `memoryRebuild` through job admission, supplying
   tab context, chat slot and full admission. `createGenerationRunner` dispatches to `runMemoryRebuild` before
   `prepare`'s group-chat refusal; `admitRecord` still refuses an adoption-held chat. `runMemoryRebuild` owns the
   remaining start/resume refusals.
2. `store.memory.rebuild.begin` and `MemoryTaskService.rebuild` share one synchronous step; a refused queue abandons the
   new run. The task gives the unchanged writer `rebuildStore` and `manual: true`, with `historical` for backfill.
   Reads, writes and [failed-window replay](writer.md#a-writer-run) all use staged records, including staged runs.
   `commitOfRebuild` owns the commit fence and ceiling; commits write no chat receipt and move no chat revision for the
   tab's fence.
3. At `maxWriterWindows` or half of `taskDeadlineMs`, the task queues its input again and ends `done`
   (`rebuildContinues`). The next task repeats `startChecks`: changed settings stop the run at that start, never
   mid-task. A window that does not record stops spending until a person resumes. `noteRebuildStop` keeps its reason and
   error on the row beyond the task's `terminalRetentionMs`.
4. Resume (`{ resume: true }`) passes the same admission with current settings. At the cursor's end `swapRebuild` checks
   the fence and live hold, computes `rebuildChanges` and swaps, ending `done` (`rebuilt`). The task service's rebuild
   comments own cursor progress, empty windows and `nothingRecorded`.

`DELETE /api/memory/tasks/...` pauses the task and keeps the run. The panel's `abandonStructuredMemoryRebuild` calls
bodyless `POST .../rebuild/abandon`; the route cancels the task and removes the run and staging in one synchronous step.
Its comment owns refusals and no-run behavior.

The run keeps the panel read-only after its task ends. The panel must reread contents at that end to discover a swap or
abandon and release read-only; the tab's task fence alone cannot release a run's lock.

### The plan

Read `rebuildPlan` in `server/src/prompt/memory/structured/rebuild.ts`.

### What a rebuild keeps

`rebuildSeed` supplies `begin` before the writer starts; `seededPage` owns preservation of a person's page choices and
`rebuildChanges` owns replacement and carry rules. Events are not seeded: carry is decided against live records at the
swap, so a retraction during the run counts. See [page tools](pages.md#what-a-merge-or-split-does-to-history) for the
`reshaped` mark.

No chat or `hypaV3Data` is written. An adopted chat's stored summaries stay until [reset](projection.md#the-reset), and
the projection stands aside while they remain. The live store's write also preserves an adoption decline.

### Backfill

Backfill includes an adopted chat's user messages that summaries left uncovered, even when their replies were recorded.
Its windows precede existing records, so `rebuildWork` gives the staged writer `historical: { frozenPages }`:
`admissionState`, `historicalAnalysis`, `withoutFrozenTargets` and `commitPages` leave existing pages, their links, the
scene and threads alone while adding events and new pages. `rebuildSeed` and `rebuildChanges` own the seed and swap
preservation rules.

### The swap

`swapRebuild` reads live records and their revision, builds `rebuildChanges`, then calls `store.memory.rebuild.swap`.
`server/src/data/resourceStore.ts` wraps `server/src/data/memoryStore.ts`'s swap in one transaction: one ordinary live
`write`, moving the memory revision exactly once. The store's comments own validation, scene and `createdRevision`
rules, staged-run transfer and cleanup.

Only this changes what a chat reads. Staged writes touch no live tables and publish nothing; a plugin refreshes one
projection for the swap. Failure or abandon leaves live records and their revision alone.

### During a run

The lock is the run row, lasting until a completed resume or abandon. Job admission is the chokepoint: a stopped run's
send could write live records through a gap run or hand-off that the swap would lose. The fences span
`server/src/jobs/generationJobs.ts`, `server/src/app.ts`, the writer's commit and the store's `rebuilding` read.

| During a run                              | What happens                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Send, continue, command, `memoryRecord`   | Admission refuses 409 `memoryRebuilding`; the tab's words name the panel     |
| Preview                                   | Allowed: no write                                                            |
| `memoryRebuild`                           | Reaches admission; an existing run requires resume                           |
| Panel edit, revert, adopt, decline, reset | 409 `fenced`; restore and inherit into the chat too                          |
| Inherit from, chat file, checkpoint save  | Allowed: reads live records                                                  |
| Checkpoint load                           | Refused as `generating` via `loadLocked`; `busy` would also bar saves        |
| Chat deletion                             | `invalidate` ends the task; cascade removes run and staging                  |
| Whole-chat replace                        | Task ends; `noteSourceReplaced` prevents resume; abandon still works         |
| Message edit or confirmed delete          | `reconcileMessageChanges` reacts on live records, then staging               |
| In-flight window's source changed         | Stops `windowChanged`; resume rereads that window                            |
| Live writer past admission                | `commitWindow` refuses `windowChanged`; staged `rebuildStore` reports no run |
| Algorithm switched away                   | `rebuilding` releases job/load locks; run waits for the panel to return      |
| Maintenance, shutdown, restart            | Task ends, run stays; no automatic resume or startup scan                    |
| Snapshot restore                          | `DELETE FROM chats` cascades the run away                                    |

The algorithm is the one global setting (`structuredMemorySelected`), so a switch releases every chat's run. Memory
routes still fence the run: their fence reads `status`, not `rebuilding`. A checkpoint load it lets through is a
whole-chat replace, so that run can then only be abandoned.

### The cost preview

`readStructuredMemoryCost` calls `GET .../cost`; the route uses `memoryWorkCost` and answers
`StructuredMemoryCostAnswer` without writing or accepting a record. The route comment owns query admission, the builder
owns window counting, and the shared answer and `memoryCostTokens` own the
[estimate](../../audit/structured-memory-2026-11-03.md).

`pressMemoryRebuild` asks for rebuild/backfill when cost is nonzero or unknown; a zero-window preview ends with a toast.
`pressMemoryRecord` asks at two calls or more, or an unreadable preview with unknown cost, before submitting the job.
The press functions and `recordTurns` own cadence conversion; the server accepts `turns` 1 or 2 without checking that
cadence.

### The language change

The writer's `openRun` stores `language`; the contents route reads the newest `recorded` run's language as
`recordedLanguage`. The panel's `languageChange` compares it with `structuredMemoryWriterLanguage` and offers a line
beside the rebuild buttons. The comparison starts no work; a person must press. The panel owns the no-language case.

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

- `structured/rebuild.test.ts` drives the plan, window, cost, seed, and `rebuildChanges` on plain records.
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

- A stopped run keeps the lock until a person resumes or abandons, across restarts too. Decision: Structured Memory
  slice 6b, archive.
- A backfill adds events and new pages and leaves current state alone: existing pages, the scene, and threads learn
  nothing from it. A rebuild refreshes them. Decision: Structured Memory slice 6b, archive.
- A rebuild forgets reverts on sections with no mark: such a section is written anew, its history goes, and the writer
  can propose the change again. Decision: Structured Memory slice 7b, archive.
- A person's state change on a writer's thread does not survive a rebuild: only `openedBy` says whose a thread is.
  Decision: Structured Memory slice 6b, archive.
- Old receipts stay on their messages, with their event and run ids, as on a copied chat. Decision: Structured Memory
  slice 6b, archive.
- Seeded and carried text stays in its language, and a resume under another language leaves a mix. Decision: Structured
  Memory slice 6b, archive.
- A pin spreads to every staged event sharing a message, so an adopted summary's pin reaches all its turns' events.
  Decision: Structured Memory slice 6b, archive.
- The cost preview's `record` mode has no cadence, so `everyK` above 2 overstates calls. Decision: Structured Memory
  slice 6b, archive.
- A build from before these tables opens an upgraded database and ignores them: no lock, so a stopped run's later swap
  would lose what that build recorded. No snapshot refuses anything, and its restore drops them. Decision: Structured
  Memory slice 6b, archive.

### Gotchas

- A snapshot's size includes a stopped run's staged rows, prompts in `input` included, until the run ends.
- A rebuild's runs join the Log whole and are never pruned, so a long chat's rebuild adds about its prompts in storage,
  which every checkpoint save then reads ([Limitations](lifecycle.md#limitations)).
- `seq` is storage order, so after a backfill the last stored event is an old one: `admissionState` and `previousTitle`
  read it, and the next ordinary window can compare against it. The read path sorts by place.
- A swap holds the event loop for one parse of the chat's pages and events, in one synchronous step.
