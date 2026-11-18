# Timeline Chapter Synopses Plan audit, 2026-11-18

- Plan: `docs/plan/timeline-chapters.md`
- Commit audited: `de6954fee`, the commit that added the plan. The corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6.2-Astra (`xhigh`), read-only, at the owner's request in place of the procedure's Sol because the plan
  adds a table, a job, and store writes; report written by the session that drafted the plan (Claude Fable 5.2),
  before any plan-runner run
- Prerequisite: the plan starts after `docs/plan/timeline-reading.md` lands, and the audit treated what that plan
  adds as given

| Severity   | Count |
| ---------- | ----- |
| P1         | 4     |
| P2         | 24    |
| P3         | 9     |
| unverified | 0     |

All 37 findings are closed and `fixed in plan`. None of the four P1 loses data: each is a decision that could not
work as the draft wrote it. The first turn filed H1 to H23. The plan was then rewritten, and the second turn
confirmed 21, disputed H3 and H4 (the corrections were sound in direction and incomplete), and filed H24 to H34
against the rewrite. The third turn confirmed those except the wording of H34 and filed H35 to H37; the fourth
confirmed the rest and found nothing open.

Three of the corrections narrowed decisions the owner had accepted, and the plan's Decisions say so: C9 (a native
snapshot file physically holds the rows), C11 (the server counts the requests and enforces the number the press
authorizes), and C12 (automatic making runs only after the detached writer task).

Astra changed no file in the repository (`read_only_violation` was `false` after each turn) and ran no test or type
check: the audit is a reading of the code. The four turns took about 33 minutes and 18.2 M tokens.

Re-check list:

- `patchMessage` closes an open generation fence (`server/src/data/chatStore.ts:1820`, `:2584`). Chapter writes use
  their own table and patch no message; the plan does not rely on it.
- Feed rows are measured whole against the 64 KiB cap (`shared/resources.ts:551`, `chatStore.ts:1942`, `:2002`). No
  chapter needs a feed row.
- `STORE_TABLES_SQL` runs at version zero and on a newly created output file
  (`server/src/data/resourceStore.ts:3862`, `:798`); existing databases reach `openChatSchema`, which runs
  `CHAT_OPEN_SCHEMA_SQL` (`resourceStore.ts:1077`, `chatStore.ts:1312`). Slice 1 depends on exactly that
  distinction, and says so.
- `sendText` returns true only when an eligible socket's send succeeds (`server/src/jobs/generationJobs.ts:1042`,
  `:1059`, `:1074`), so the README's entry is broader than the code. Chapter writes and the job's end do not depend
  on delivery; only the result toast does.

Found consistent (paths under `server/src/` unless they say otherwise):

- **Opening and validation.** Version zero initializes schema 3 and other versions are refused
  (`data/resourceStore.ts:3856`); every supported open runs `openChatSchema` (`data/chatStore.ts:384`).
  `memory_event_sources` is a valid create-on-open precedent. Layout and group checks look up named tables
  (`data/resourceStore.ts:562`, `:632`, `:3740`), so an extra healthy table refuses nothing, and a build from
  before the table opens a database that has it.
- **Restore and deletion.** Snapshot restore, archive import, and upstream import converge on `restoreValidated` and
  `replaceAll` (`routes/backups.ts:619`, `:689`, `data/resourceStore.ts:804`, `:3242`). Staging has no chapter sink
  (`data/memoryStore.ts:1384`); installation deletes the live chats with foreign keys on and inserts fresh chat
  sequences. Chat and character deletion delete the parent rows (`data/chatStore.ts:2344`, `:3292`). No path leaves
  a chapter on a wrong or reused sequence.
- **Chapter writes and C15.** `store.memory.write` has the pattern the plan copies: writable, epoch, a synchronous
  `BEGIN IMMEDIATE`, rollback, and a counted write (`data/resourceStore.ts:1166`, `:2042`, `:2229`). The snapshot
  scheduler watches the write count (`data/snapshots.ts:346`); the writer retries on a revision conflict
  (`prompt/memory/structured/writer.ts:641`). Chapter writes can count as store writes without moving the revision.
- **Exclusion.** A held generation slot blocks a second job (`jobs/generationJobs.ts:373`, `:2393`); a stored
  rebuild blocks job creation (`data/resourceStore.ts:2432`); a checkpoint load checks the same busy state
  (`data/checkpointService.ts:275`). The edit route supplies the authentication, limiter, epoch, maintenance, and
  fence pattern for the removal route (`routes/structuredMemory.ts:1154`).
- **One owner.** The server is one process that owns the live database (`app.ts:359`, `data/resourceStore.ts:885`,
  `docs/structure/server-resources.md:410`); the restore worker writes staging, the importer its own build file,
  and the asset scanner reads only. A synchronous re-read followed by `add` admits no writer in between.
- **Writer paths and rebuild.** `structuredWork` is the detached completion point, apart from the send's gap
  recording, the dry-run test, and the staged rebuild writer (`prompt/memory/memoryTasks.ts:1451`,
  `prompt/memory/structured/recordJob.ts:363`, `testRun.ts:272`). The stored rebuild modes are `rebuild`, `fresh`,
  and `backfill` (`shared/structuredMemory.ts:37`), and the inner swap holds the chat sequence and the stored run
  (`data/memoryStore.ts:853`, `:1243`). Backfill folds keep ids and text
  (`prompt/memory/structured/rebuild.ts:321`).
- **Inheritance.** The route checks the target for rows, builds `inheritedRecords`, and writes once, synchronously
  (`routes/structuredMemory.ts:173`, `:1354`, `:1381`); crossed events keep id, title, summary, date, and status
  (`prompt/memory/structured/inherit.ts:117`). A chapter copy can follow that write with no await.
- **Record boundaries.** Checkpoints, chat files, and the package enumerate the known kinds
  (`data/checkpointStore.ts:393`, `:683`, `shared/structuredMemory.ts:1332`, `routes/structuredMemory.ts:869`), and
  the run-result and history-kind validators are closed lists (`data/memoryStore.ts:188`,
  `prompt/memory/structured/restore.ts:128`). A table outside them needs no new discriminator.
- **File lists.** Slices 3 and 5 share no listed file; slice 4 is the only later editor of the language files and of
  `tests/memoryTasks.test.ts`.

## P1

### H1 — C9: the snapshot writer copies chapter rows — fixed in plan

- Plan (C9): "They are not in snapshots, restores, chat files, the Markdown package, or checkpoints."
- Code: a snapshot is `backupTo` of the whole database (`data/snapshots.ts:319`, `data/resourceStore.ts:3185`), and
  a native backup archive starts from that copy (`routes/backups.ts:335`, `data/exportScrub/worker.ts:16`).
- Correction, confirmed (with H34): a native snapshot and the SQLite payload of a native backup archive hold the
  rows; a restore does not read them, and the upstream-compatible export does not write them. Removing them from
  those files is in Not In This Plan, and slice 1 tests the restore's result.

### H2 — Slice 2: the command could not reach its runner — fixed in plan

- Plan (Slice 2): "`{ type: "memoryChapters" }` joins `GenerationCommand`; `createGenerationRunner` dispatches it."
- Code: `parseCommand` admits an explicit list and answers 400 before `jobs.create` (`routes/generations.ts:76`,
  `:127`, `:341`); the tab's `runServerJob` needs a `ServerJobLabel` and its discarded-write string
  (`src/ts/process/serverCommands.ts:1065`, `:1201`).
- Correction, confirmed: slice 2 adds the parser case and tests an actual POST; slice 3 adds the label and the two
  language strings and reports only a usable `done` result.

### H3 — Slices 1 and 2: the job slot and `add`'s checks did not preserve the selected unit — fixed in plan

- Plan (Slice 2): "the job's signal as the fence"; (Slice 1) `add` checks that each listed event exists, is not
  retracted, has the listed mark, and is in no other chapter.
- Code: `runMemoryTest` checks the task status once and takes no lease (`testRun.ts:202`); a task can be queued
  later (`routes/memoryTasks.ts:85`, `prompt/memory/memoryTasks.ts:1604`, `:1892`); a removed message can retract
  an event through the chat-write listener (`prompt/memory/structured/reconcile.ts:499`), which can move an
  unchanged member into the newest ten; a whole-chat replace keeps `chats.seq` (`data/chatStore.ts:2386`).
- Correction, confirmed over two turns: no lease. Every chapter write is preceded, with no await, by a guard on the
  caller's signal, maintenance, the epoch, and the chat's source generation, as the writer's commit guard checks
  them (`prompt/memory/structured/recordJob.ts:189`), and the maker re-derives the eligible units from the store
  and adds only when the unit it sent is still one of them. The group size is read from the store as it is now
  (`data/resourceStore.ts:2320`), not from the job's frozen scope.

### H4 — Slice 4: catching an error could not keep an automatic call from changing the recording's end — fixed in plan

- Plan (Slice 4): "Every outcome but an abort is swallowed: a failure writes nothing, changes neither the task's nor
  the job's end."
- Code: a host failure aborts the host's signal and an escaped error fails the task
  (`prompt/memory/memoryTaskHost.ts:109`, `:143`, `prompt/memory/memoryTasks.ts:989`); in a job the request services
  can send a notice and latch a fatal error into the shared signal (`lua/bindings.ts:1130`, `jobs/runSetup.ts:323`);
  the task's 30-minute timer can publish `failed` while the call is out (`prompt/memory/memoryTasks.ts:131`,
  `:1486`); a provider can ignore an abort (`llm/requests.ts:1051`).
- Correction, confirmed over two turns: the step runs only in `structuredWork`, on a host and signal of its own; the
  task fixes its end first; the step is skipped unless the timer has more than the two-minute deadline and a margin
  left; the task waits through `untilAborted` (`jobs/runSetup.ts:103`), a late continuation finds the guard
  refused, and the abandoned request stays counted until it settles (`prompt/memory/memoryTasks.ts:875`). The
  in-job record path makes no chapter (C12).

## P2

Each is `fixed in plan` and was confirmed by the auditor.

- **H5 — Slice 1, `/chapters` in rounds.** Paging by offset over a list that can change mixes two states
  (`routes/structuredMemory.ts:219`, `:855`, `:948`). Now one response with no rounds, with the stored bytes summed
  before a body is read, as `readProjection` does (`data/resourceStore.ts:2290`).
- **H6 — Slice 2, admission.** `admitRecord(job, deps, undefined)` still refuses a chat whose memory is off, whose
  summarizer is local, or that is held for adoption (`prompt/memory/structured/recordJob.ts:98`, `:127`), and the
  panel can open with recording off (`src/App.svelte:377`). The plan lists the refusals and the button is off when
  memory is off.
- **H7 — Slice 2, the frame.** `compactSlots` only supplies values; a separate assembler takes the host and the
  clamped instructions (`prompt/memory/structured/prompts.ts:246`, `:421`, `:444`, `:532`), and the writer's `call`
  adds reply handling a caller outside a run must redo (`writer.ts:839`). Slice 2 now has `chapterSlots`,
  `assembleChapterPrompt`, a host built with `writerHostDeps`, and no stored totals.
- **H8 — C13.** A gap before an existing chapter closes with a unit of any length; C13 and the rule now agree.
- **H9 — Slice 3, the count.** The tab and the server place events differently (the tab falls back to a stored
  position, `src/ts/process/structuredMemory.svelte.ts:2139`; the server does not, `data/memoryStore.ts:1468`), so a
  tab estimate could miss the confirmation. The press now reads `GET .../chapters/cost` and the command carries the
  authorized `limit`.
- **H10 — Slice 3, the label.** Coverage and story can come from different revisions (`TimelineTab.svelte:47`,
  `:145`, `:175`). The tab compares only when its three reads carry the same memory revision.
- **H11 — Slice 3, layout.** A chapter whose first event was retracted or removed had no anchor
  (`prompt/memory/structured/reconcile.ts:332`, `data/memoryStore.ts:1087`). It now stands at its first listed event
  that Read still lists.
- **H12 — Slice 3, "Make again".** Remove-then-run could make a different chapter or fail after the removal. It is
  now its own command shape, and the store's `replace` swaps in one transaction after a usable answer.
- **H13 — Slice 4, when.** A task can end `done` having recorded nothing, and the record job treats excess windows
  as `done` (`prompt/memory/memoryTasks.ts:1193`, `:1236`, `prompt/memory/structured/recordJob.ts:235`, `:271`). The
  step now needs a recorded window and none left.
- **H14 — Slice 4.** "A failure writes nothing" ignored the orphan cleanup that precedes the request; the text now
  says that cleanup stays.
- **H15 — Slice 5, carrying.** `add`'s checks refuse a crossed chapter with a retracted or edited member
  (`prompt/memory/structured/inherit.ts:114`, `:226`). Carrying is now a separate `copy` that keeps the marks.
- **H16 — Slice 5 and C14.** A repeated event can gain a date under the same id and text
  (`prompt/memory/structured/analysis.ts:639`, `:679`), which the frame reads. The mark now covers the date, and
  the checkpoint paragraph no longer says a later chapter is always out of date.
- **H17 — Current State, refresh.** `refresh` moves on a combined fence transition, not on every end
  (`StructuredMemoryPanel.svelte:164`, `:180`). The tab rereads after its own actions, and C16 records the rest.
- **H18 — Slices 1 and 5, `clear`.** A public mutator inside `rebuild.swap` would nest a transaction, which the
  store refuses (`data/resourceStore.ts:1516`, `:2229`, `:2440`). The inner swap deletes with its own statement from
  the stored mode; no flag crosses, and slice 5 does not edit `memoryTasks.ts`.
- **H24 — Slice 2, the loop.** Adding one chapter can regroup the remaining run, so units picked up front could all
  be rejected after their requests. The maker now picks the next unit immediately before each request.
- **H25 — Slice 3, an unrepairable label.** A label for an interposed row could not be cleared by a remake. That
  rule is gone; a changed order of the listed events is a reason instead.
- **H26 — Slice 2, remake.** Absorbing rows between members could pull in a newest-ten event or, from an unplaced
  endpoint, the whole tail. A remake now takes only its listed, unretracted, placed events.
- **H27 — Slice 5, copy.** A target holding only chapter rows (an empty-memory checkpoint loaded into an inherited
  chat) passes `holdsRows` (`routes/structuredMemory.ts:173`), so a second inheritance could list one event twice.
  `copy` skips a chapter that overlaps the target's.
- **H28 — Slice 3, read order.** A chapters read begun before a removal could finish after the reread. Reads carry
  a request number, as story reads do (`TimelineTab.svelte:171`).
- **H29 — Slice 3, revealing.** Chapters arriving after a reveal could move its event into a closed chapter. A
  reveal in Read waits for the chapters read too.
- **H30 — Slice 1, the mark.** The tab drops an invalid date and reads a non-string summary as empty
  (`src/ts/process/structuredMemory.svelte.ts:358`, `:695`), while `formatStoryDate` formats without validating
  (`shared/structuredMemory.ts:431`). `memoryChapterMark` now normalizes its own input.
- **H35 — Slice 2.** A re-recorded member's replacement is not always a closed gap; it is loose and follows the
  ordinary rule.
- **H36 — Slice 2.** A removed source message can unplace or move an event with its mark and the source generation
  unchanged (`data/chatStore.ts:2669`). A remake recomputes its ordered list immediately before `replace`.
- **H37 — Slice 3.** Waiting for a chapters read in Manage, which reads none, would strand a focus. The wait is in
  Read only.

## P3

Each is `fixed in plan`.

- **H19 — Current State.** The projection orders reconciled copies and retrieval has its own order
  (`prompt/memory/structured/retrieve.ts:422`, `:1009`); the extracted helper is passed reconciled events by the
  projection and stored events by the chapter code.
- **H20 — Current State.** `memory_state` has two accepted layouts (`data/memoryStore.ts:1277`, `:1318`).
- **H21 — File lists.** `detachedHostDeps` is private to `testRun.ts` (`:79`), the boot fixture compares presets
  whole (`src/ts/storage/tests/bootSnapshot.test.ts:215`), and slice 4's guide is `writer.md`.
- **H22 — Slice 2, manual check.** `writerLanguage` resolves the current effective language (`writer.ts:290`), not
  the recorded one.
- **H23 — Slice 1, tests.** The pure rule never sees retracted or unplaced events; that filter is tested at its
  callers.
- **H31 — Slice 5.** A carried chapter's label is derived in the target, where an interleaving event may not have
  crossed.
- **H32 — Slice 2, guide.** `docs/structure/server-generation.md` lists the memory command exceptions (`:123`) and
  joins slice 2.
- **H33 — Slice 3 and C11.** One request is authorized by the press itself; a failed cost read sends nothing.
- **H34 — C9 and Current State.** Only native snapshots and the SQLite payload of native backup archives hold the
  rows; the upstream-compatible export writes its own projection (`routes/backupsUpstreamExport.ts:260`).
