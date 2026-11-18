# Timeline Chapter Synopses Plan

Status: drafted 2026-11-18 at `de5357ca5` from the owner's request; the owner accepted C1 to C7 the same day and the
defaults of C8, C10, C11, and C12 after reading the draft (Decisions); audited the same day by a read-only
GPT-6.2-Astra session in `full` mode, at the owner's request in place of plan-runner's own audit
([report](../reports/audits/plan-runner/timeline-chapters-2026-11-18.md): four P1, none losing data, 24 P2, and
nine P3, all fixed in this text; the fixes narrowed C9, C11, and C12). The report and this line share the plan's
last commit, so a plan-runner run skips its Plan audit unless the plan changes again. Starts after
[Timeline Reading View](timeline-reading.md) lands: it builds on that plan's Read view, its rule for revealing an
event, `memoryEventGroups`, and `eventsPerGroup`. Landed: 1 (`fda81e603`).

Sources: the owner's request and answers (2026-11-18: re-summarize runs of events into synopses, a structure the
owner once built as a whole-story memory, now to show a person the story; a button to make them and a checkbox for
making them automatically; the latest events stay out, since settled history is rarely edited); the owner's reference
`process/summary.py` (leaf summaries re-summarized into past summaries, which are merged again); the store, the
routes, the writer, the memory task service, and the lifecycle code under `server/src/data/`,
`server/src/routes/`, `server/src/prompt/memory/`, and `server/src/jobs/`, read at `de5357ca5`; the
[structured memory guides](../structure/structured-memory/README.md). Seven read-only research workers gathered the
anchors and the session re-read the ones a slice rests on. Identifiers are the anchors; re-verify each cited location
before editing (STRUCTURE.md protocol step 5).

## Goal

A long chat's older events read as chapters: a title and a synopsis over a run of events, in the Timeline's Read
view, with the events one press below.

- **A guide to the place, not the answer.** A chapter tells a person where in the story something happened; the
  events, their key lines, and the original messages below it still answer "did this happen?".
- **Made on request.** A button makes the chapters that are missing; a preset option makes them as events accrue.
- **Settled history only.** The newest events never enter a new chapter.
- **Honest when stale.** A chapter whose events changed says so and offers to be made again; nothing regenerates on
  its own.

Not goals: putting chapters into the prompt (C1); a second level that summarizes chapters (C6); carrying chapters
through a restore, chat files, the Markdown package, or checkpoints (C9).

## Current State

- A chat's memory records are `pages`, `events`, `threads`, and `runs` (`MEMORY_RECORD_KINDS`), stored in the five
  tables of `MEMORY_TABLES_SQL` (`server/src/data/chatStore.ts`), which a restore treats as one optional group: all
  absent is accepted, a subset is refused, and each present table must match one of its accepted exact layouts
  (`memory_state` has two). The restore's walk, its sink, and `copyStagedMemory` enumerate those tables; a table
  outside the group is neither walked nor copied, and installing a restored or imported database deletes the live
  chats first, so rows keyed to `chats.seq` with `ON DELETE CASCADE` go with them.
- A native snapshot, and the SQLite payload of a native backup archive, is a copy of the whole SQLite file
  (`backupTo`), so it physically holds every table, including one outside the group; only what a restore reads back
  is limited to the known tables. The upstream-compatible export writes its own projection, without such a table.
- `memory_event_sources` is the precedent for a derived table outside the group: it is created by
  `CHAT_OPEN_SCHEMA_SQL`, which `openChatSchema` runs at every open, with no `SCHEMA_VERSION` change.
  `STORE_TABLES_SQL` runs only on a fresh database, which is why the table must not be added there alone.
- `store.memory.write` (`resourceStore.ts`) is the pattern for a memory mutation: it checks that the store is
  writable and that the caller's epoch is current, runs one synchronous `BEGIN IMMEDIATE` transaction, and counts a
  real write for the snapshot scheduler. The inner write validates the whole change set and moves
  `memory_state.revision` once. The store refuses a transaction opened inside another.
- Checkpoint manifests, chat files, the package, and inheritance each list the record kinds they carry; none has a
  slot for another kind, and an older build checks `MEMORY_RUN_RESULTS` and `MEMORY_HISTORY_CHANGE_KINDS` as closed
  lists.
- An event's title or summary changes in place through the panel's `eventText` edit and through a checkpoint load,
  which restores captured rows under the same ids. A repeated event can gain a `storyTime.date` under the same id,
  title, and summary. A re-record leaves the old id retracted and commits a new id (`retireRerecorded`). A rebuild
  removes the live events it replaces and installs staged ids; a fresh rebuild removes every live event; a
  backfill's folds keep ids and text and can add sources. A removed message can retract an event through the chat
  write's listener, with no job. An event has no revision of its own: `createdRevision` is stamped once, and
  `/coverage` sends no summary.
- `projectChatMemory` (`server/src/data/memoryStore.ts`) reconciles the events against the messages, places each by
  its earliest current message position (a greeting citation at -1, an event no message places last), sorts
  stably, and projects the result, which leaves out events that are not active. The tab's `memoryTimelineRows`
  places an event with no surviving message by its stored position instead.
- Compaction is the model for an extra writer call's frame: `compactSlots` builds the slot values,
  `assembleCompactPrompt(host, instructions, slots)` builds the messages from a code-owned frame that `fineTuning`
  never replaces, with the preset's `instructions` trimmed and clamped by `addedInstructions`, and the language
  comes from the writer's `writerLanguage`, which resolves the current effective language. The writer's `call`
  wrapper, inside a run, turns a failed, unexpected, or blank reply into a reason, records the model and the token
  counts on the run, and lets a thrown `MemoryHostFailure` settle the run as failed.
- `runMemoryTest` (`testRun.ts`) is the model for a panel-started model call that records no run: a `command` job,
  admitted by `admitRecord`, refused when `jobMemoryBlockingReason` names a plugin model or a request trigger or
  when the chat's memory task is queued or running, with a host from `createMemoryTaskHost` over the file-private
  `detachedHostDeps` wrapped by `writerHostDeps`, the job's signal as its fence, and its result in the job's `done`.
  It checks the task status once and takes no writer lease, so a writer task can be queued after it started.
- A command reaches its runner through three lists: `GenerationCommand` (`shared/jobs.ts`), the wire parser
  `parseCommand` (`server/src/routes/generations.ts`), which answers 400 for a shape it does not name, and
  `createGenerationRunner` (`commandRunner.ts`). On the tab, `runServerJob` takes a `ServerJobLabel`
  (`src/ts/process/serverCommands.ts`) and shows `serverJob.discarded[label]` from the language files.
- `admitRecord(job, deps, undefined)` skips the target-message check and still refuses a chat whose algorithm is not
  Structured Memory, whose memory is off, whose summarizer is the local model, or that is held for adoption. Job
  creation itself refuses a chat that is busy with another job or whose rebuild is running.
- The record press asks the read-only `/cost` route for its number of calls before it sends its command
  (`pressMemoryRecord`).
- The detached writer task finishes its windows in `structuredWork` (`memoryTasks.ts`), which counts the windows it
  recorded (`task.done`) and ends `windowsLeft` when more remain; it can also end `done` having recorded none. A
  host failure aborts the host's own signal, and an error that escapes the task's work fails the task; a task has a
  30-minute timer. The service's queue holds one running task and one pending input per chat.
- The inner `swap` of `store.memory.rebuild` (`memoryStore.ts`) runs inside the facade's transaction and holds the
  run's chat sequence and its stored mode; it writes the changes, copies the staged runs, and removes the run.
- The inherit route builds the target's records with `inheritedRecords`, which keeps each crossed event's id, title,
  summary, and status (a retracted event can cross), and writes them with one synchronous `store.memory.write`.
- The panel's `refresh` moves on an install of the chat, when its combined read-only state falls, and when a
  rebuild's task ends. A command the tab follows and a memory task it sees both hold read-only up and let it fall
  when they end, unless another fence is still up; a command started from another tab is not among them.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_.

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused command
  `pnpm --silent test:agent structuredMemory StructuredMemory memory/structured memoryStore memoryTasks memoryJobs MemorySettings normalizeCollections memoryTaskHost`,
  then `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, `pnpm check:docs` for
  a guide edit, and `pnpm check:tests` after adding or moving a test. Run `pnpm check` again after the last test
  edit. V4 and V6 as the repository states them.
- **Outside the record set.** A chapter is not a memory record kind. It never enters `MEMORY_RECORD_KINDS`,
  `MemoryChanges`, the prompt, the HypaV3 projection, the package, a chat file, a checkpoint manifest, or the
  restore's table group, and a chapter write never moves `memory_state.revision`.
- **Never in the way.** No chapter failure fails a writer run, a send, or a panel read, and a chat with no chapter
  behaves exactly as it does today. The one coupling is the rebuild swap, which deletes chapters inside its own
  transaction (slice 5).
- **Every chapter mutation takes the caller's epoch** and follows `store.memory.write`'s pattern: writable store,
  current epoch, one synchronous transaction, counted as a store write.
- **Strings.** New user-visible text goes in `src/lang/en.ts` under `structuredMemory`, with its Korean in
  `src/lang/ko.ts` in the same slice. The Korean for a chapter is 장 and for its text 줄거리.
- **Plain text.** A chapter's title and synopsis are rendered as text, never as Markdown or HTML.
- **Persisted values.** A new preset or wire field is optional, and absent means today's behavior.
- **Guide.** Each slice names its guide and updates the sections that name a changed contract; a guide stays under
  the 40,000-byte ceiling (`read.md` has the least room). Comments and test titles describe behavior, not this plan.
- **Tests.** Routes in `server/src/tests/structuredMemoryRoutes.test.ts`, the store in
  `server/src/tests/memoryStore.test.ts`, the job on a real stack in `server/src/tests/memoryJobs.test.ts`, the task
  in `server/src/tests/memoryTasks.test.ts`, pure rules beside their module, the panel in
  `StructuredMemoryPanel.test.ts`, the tab client in `src/ts/process/structuredMemory.test.ts`.
- **Manual checks.** Each slice lists the browser, device, and real-model checks it cannot run; what is unrun when
  the plan closes moves to [manual checks](../backlog/manual-checks.md) under this plan's name.

## Order

1 → 2 → (3 ∥ 5) → 4. Slice 1 gives the record, the store, and the read and remove routes. Slice 2 gives the maker
and its command, which slices 3 and 4 start. Slices 3 and 5 share no file: slice 3 edits `TimelineTab.svelte`,
`memoryRecordPress.ts`, `src/ts/process/serverCommands.ts`, `structuredMemory.svelte.ts` and its test, the language
files, the panel test, and `read.md`; slice 5 edits `memoryStore.ts`, `resourceStore.ts`,
`server/src/routes/structuredMemory.ts`, their tests, `lifecycle.md`, and `rebuild.md`. Slice 4 is last: it edits
the language files after slice 3 and `server/src/tests/memoryTasks.test.ts` after slice 5. If the run stops early,
slices 1 to 3 stand alone as chapters made by the button.

## Slice 1. The chapter record, its table, and its routes (_hard_, `structured-memory/records.md`)

Files: `shared/structuredMemory.ts`, `shared/structuredMemory.test.ts`, `server/src/data/chatStore.ts`,
`server/src/data/memoryStore.ts`, `server/src/data/resourceStore.ts`, `server/src/routes/structuredMemory.ts`,
`src/ts/process/structuredMemory.svelte.ts`, `server/src/tests/structuredMemoryRoutes.test.ts`,
`server/src/tests/memoryStore.test.ts`, `src/ts/process/structuredMemory.test.ts`, `records.md`.

- **The record.** `MemoryChapter` is `{ id, title, synopsis, events }`, where `events` is the list, in story order,
  of `{ id, mark }` for each event the chapter was made from. The title is at most
  `STRUCTURED_MEMORY_LIMITS.eventTitleChars`; the synopsis at most a new `chapterSynopsisChars` (1,200).
- **The mark.** `memoryChapterMark(title, summary, date)` in `shared/structuredMemory.ts` is a synchronous,
  deterministic, non-cryptographic hash of what the chapter's frame reads of an event: its title, its summary, and
  its story date. It normalizes its own input, so the server (reading a stored row) and the tab (reading `/coverage`
  and `/story`) get the same mark from the same record: a title or summary that is not a string counts as empty, as
  the story reader's fallback has it, and a date is formatted with `formatStoryDate` only when `isStoryDate` accepts
  it and counts as absent otherwise. The frame and the grouping use the same normalized values. It detects a change;
  it protects nothing (C14).
- **The units.** `memoryChapterUnits(events, size, recent)` in `shared/structuredMemory.ts` is the rule for which
  events a new chapter covers. Its input is a chat's events in story order, each with an id, an optional date, and
  whether a chapter already lists it. Its callers leave out retracted events and events no message places before
  the call, so the rule never sees them.
  - The newest `recent` events (`STRUCTURED_MEMORY_LIMITS.chapterRecentEvents`, 10) are never in a unit (C3, C8).
  - Among the rest, each run of events between chapters is grouped by `memoryEventGroups(run, size)`; whole groups
    are gathered, oldest first, until a unit holds `size` events or more, so such a unit holds from `size` to twice
    `size` less one.
  - What is left at the end of a run waits when the run ends at the newest events. When the run ends at an existing
    chapter, what is left forms a unit of its own, however short, so a gap between chapters always closes (C13).
- **The table.** `memory_chapters` (`seq` autoincrement, `chatSeq` referencing `chats(seq)` with
  `ON DELETE CASCADE`, `id`, `data` as stored JSON, unique `(chatSeq, id)`, strict) is created by
  `CHAT_OPEN_SCHEMA_SQL`, outside `MEMORY_TABLES_SQL` and the restore's group, as `memory_event_sources` is. No
  `SCHEMA_VERSION` change.
- **The store.** `store.memory.chapters`, each mutation under the rule above:
  - `list(characterId, chatId)`: the chat's chapters in `seq` order, with the memory revision of the same read.
  - `add(characterId, chatId, epoch, chapter)`: in its one transaction, refuses unless every listed event exists,
    is not retracted, has the listed mark, and is in no other chapter; then inserts.
  - `replace(characterId, chatId, epoch, chapterId, chapter)`: the same checks, with the replaced chapter's own
    events allowed, then removes the old row and inserts the new one in the same transaction. Refused when the old
    chapter is gone.
  - `remove(characterId, chatId, epoch, ids)`.
  - The `/chapters` read takes the route's byte budget, as `readProjection` does, so the store can refuse before it
    parses a body.
- **The routes**, beside the other memory routes and under their authentication, rate limit, and epoch check:
  - `GET .../chapters` answers every chapter of the chat in one response with the memory revision of that read. It
    sums the rows' stored byte lengths before it reads a body and refuses a chat whose chapters exceed the read
    budget, which the tab shows as a failed chapters read. There are no rounds, so no round can mix two states.
  - `POST .../chapters/remove` with `{ ids }` removes those chapters; it is refused while the chat's write fence is
    up, as an edit is.
- **The tab client.** `readStructuredMemoryChapters` gives the tab well-shaped rows only and the revision;
  `removeStructuredMemoryChapters` posts the removal.
- `records.md`: Memory tables gains the table, that it is outside the group and every lifecycle walk, and that a
  snapshot file still holds its rows; the read routes gain `/chapters`; Limitations says what does not carry
  chapters (C9).
- Test:
  - `memoryChapterMark`: equal for equal input, different when the title, the summary, or the date differs.
  - `memoryChapterUnits`: the newest ten never enter; a unit closes at `size` on a group boundary; a long day cut
    into parts yields units of whole parts; the tail waits at the open end; a short tail before a chapter is a unit
    of its own; a covered event starts a new run.
  - Store: `add` refuses a missing event, a retracted one, a changed mark, an event another chapter lists, and a
    stale epoch, and leaves the memory revision as it was; `replace` swaps in one step and refuses a missing old
    chapter; deleting the chat removes its chapters; restoring a snapshot taken with chapters is not refused and
    yields none; an open of a database from before the table creates it.
  - Routes: `/chapters` answers the list with the revision, refuses a missing chat, and refuses over the budget
    without reading bodies; `remove` removes, refuses under the fence, and refuses a stale epoch.
- Manual checks: none of its own; nothing is visible until slice 3.

## Slice 2. The chapter call and its command (_hard_, `structured-memory/writer.md`)

Files: new `server/src/prompt/memory/structured/chapters.ts` and its test,
`server/src/prompt/memory/structured/prompts.ts` and its test, `server/src/prompt/memory/structured/writer.ts` and
`server/src/prompt/memory/structured/testRun.ts` (exports only), `server/src/data/memoryStore.ts` (the ordering
helper), `server/src/routes/generations.ts`, `server/src/routes/structuredMemory.ts`,
`server/src/jobs/commandRunner.ts`, `shared/jobs.ts`, `shared/structuredMemory.ts`,
`server/src/tests/memoryJobs.test.ts`, `server/src/tests/structuredMemoryRoutes.test.ts`,
`server/src/tests/memoryStore.test.ts`, `writer.md`, `records.md`, `docs/structure/server-generation.md`.

- **Order.** Extract the earliest-source placement and the stable sort of `projectChatMemory` into a helper. The
  projection passes its reconciled events through it, its output unchanged. The chapter code passes the stored
  events through it and then leaves out the retracted ones and the ones no message places; it reads titles,
  summaries, and dates as stored.
- **Eligible units.** `chapterUnits(store, chatRef)` in `chapters.ts` reads the events in that order, the chapters,
  and the chat's bound preset's `eventsPerGroup` as the store has it now (`store.memory.readWriterSettings`, not the
  job's frozen scope), and returns the units of `memoryChapterUnits`, oldest first, each with its events' marks. It
  is synchronous.
- **The frame.** `chapterSlots({ language, events })` in `prompts.ts` builds the slot values, and
  `assembleChapterPrompt(host, instructions, slots)` the messages, as `assembleCompactPrompt` does: a code-owned
  frame that `fineTuning` never replaces, with the preset's `instructions` added through `addedInstructions`. The
  frame lists each event's story date, title, and summary in order and asks for `{ "title", "synopsis" }` in the
  given language: a title within the title limit, and a synopsis within `chapterSynopsisChars` that says only what
  the events say, keeps names and the dates the events name, and uses no wording relative to the reading day. The
  language is the writer's current effective one, so `writerLanguage` (or what it reads) is exported for this
  caller.
- **The request.** One chapter request is `host.request` on a host built with `writerHostDeps`, as the test run
  builds its host. Only a successful, nonblank text reply is read; a failed, unexpected, or blank reply is a failed
  unit with a redacted reason. There is no run, so no model or token total is stored. `readChapter(text)` parses
  with `answerJson`, refuses a blank title or synopsis, and clamps either to its limit.
- **The write guard.** Every chapter write the maker makes (the cleanup, an add, a replace, a removal) is preceded,
  with no `await` in between, by one synchronous guard the caller supplies: the caller's signal is not aborted, the
  store is not in maintenance, and the epoch and the chat's source generation are the ones captured at admission,
  as the writer's commit guard checks them. A whole-chat replace that keeps every id and text still moves the
  source generation, so the guard refuses it.
- **The maker.** `makeChapters({ store, scope, host, chatRef, limit, guard })` in `chapters.ts`:
  1. under the guard, removes the chapters none of whose events exists unretracted any more;
  2. up to `limit` times: takes the eligible units as they are now and picks the oldest it has not attempted in this
     call; with none left it stops. It sends the request and reads the answer. Then, under the guard and with no
     `await` before the write, it takes the eligible units again and adds the chapter only if the unit it sent is
     still one of them with the same events, in the same order, and the same marks. Anything else (an event edited,
     retracted, or re-recorded meanwhile, a removed message that moved an event into the newest ten, a chapter
     added meanwhile that regrouped the rest) counts as failed and writes nothing;
  3. returns `{ made, failed, left }`, where `left` is the eligible units that remain.

  A refused guard or a thrown host failure ends the maker and is the caller's to report; chapters already added
  stay, and so does the cleanup of step 1. The server runs as one process that owns the live database, and its store
  calls are synchronous, so nothing can write between the re-read and the add. That is why the maker needs no
  writer lease: a writer task that starts while it runs cannot make it write a wrong chapter.

- **Remaking one.** `remakeChapter({ ..., chapterId })` takes the chapter's listed events that still exist
  unretracted and that a message places, in current message order, and nothing else: it absorbs no other event, so
  the newest-ten rule and the size never apply to it. When no listed event exists unretracted it removes the
  chapter (`"removed"`). When some exist but none is placed, or the request fails or its answer is unusable, the
  old chapter stays as it is (`"kept"`). Otherwise it sends one request. Immediately before `replace`, under the
  guard, it computes that same list again and replaces only when its ordered ids and marks equal those it sent
  (`"replaced"`); otherwise the old chapter stays (`"kept"`). An event that replaced a re-recorded member is not
  part of the remake: it is loose, and follows the ordinary unit rule, the newest-ten exclusion and the waiting
  tail included.
- **The count.** `GET .../chapters/cost` answers `{ units }`, the number of eligible units, reading no model and
  writing nothing, as `/cost` does for a record press.
- **The command.** `{ type: "memoryChapters", limit }` and `{ type: "memoryChapters", remake: chapterId }` join
  `GenerationCommand`; `parseCommand` names both shapes (a `limit` from 1 to 20, a non-empty id) and
  `createGenerationRunner` dispatches them to `runMemoryChapters` in `chapters.ts`. It is built as `runMemoryTest`
  is: `admitRecord(job, deps, undefined)` with its refusals as they are, the refusals for a plugin model or request
  trigger and for a queued or running memory task, a host from `createMemoryTaskHost` over `detachedHostDeps`
  (exported from `testRun.ts`) wrapped by `writerHostDeps`, and the job's signal. Its `done` carries
  `{ kind: "memoryChapters", made, failed, left }`, or for a remake `{ kind: "memoryChapters", remade }` with
  `"replaced"`, `"removed"`, or `"kept"`. The server makes at most `limit` chapter requests for one command. The
  command's guard is the job's signal with the captured epoch and source generation.
- `writer.md`: a section for the chapter call beside Compaction (the frame's rule, the language, what a failure
  does, that it writes no run and takes no lease); Files gains `chapters.ts`. `records.md`: the read routes gain
  `/chapters/cost`. `server-generation.md`: the command exceptions under Prompt job execution name `memoryChapters`.
- Test:
  - `prompts.test.ts`: the frame names the language, carries the instructions, lists the events in order, and is
    the default frame with `fineTuning` on.
  - `chapters.test.ts`, with a scripted host: one chapter per unit with the marks of what was read; a blank reply
    and unparseable text count as failed and write nothing; an event edited, an event retracted, and a newest-ten
    event retracted while the request is out each leave no chapter for that unit; a chat replaced with the same ids
    and texts while the request is out is refused by the guard; after one chapter is added the next unit is taken
    from the store as it then is (a run whose grouping changes once its first part is covered still yields
    chapters, not rejected requests); the limit leaves the rest counted; an aborted signal stops before the next
    request and before a write; an orphan chapter is removed first; a remake replaces on a usable answer with only
    the listed events, keeps the old chapter on a failed answer, when no listed event is placed, and when a listed
    event lost its place or changed its position while the request was out, and removes a chapter with no event
    left.
  - `memoryStore.test.ts`: the projection's cases pass unchanged through the helper; the chapter order leaves out
    retracted and unplaced events.
  - Routes: a POST of each command shape is accepted and a malformed one answers 400; `/chapters/cost` counts
    units and writes nothing.
  - `memoryJobs.test.ts`, on a real stack: the command makes chapters and reports them in `done`; it is refused
    while a memory task is queued, for a plugin model, and for a chat whose memory is off.
- Manual checks: with a real model, a made chapter reads as a fair synopsis of its events in the current writer
  language, also after the language was changed since the last recording.

## Slice 3. Chapters in the Read view, and the button (_hard_, `structured-memory/read.md`)

Files: `TimelineTab.svelte`, `src/lib/Others/StructuredMemory/memoryRecordPress.ts`,
`src/ts/process/serverCommands.ts`, `src/ts/process/structuredMemory.svelte.ts`, `src/lang/en.ts`,
`src/lang/ko.ts`, `StructuredMemoryPanel.test.ts`, `src/ts/process/structuredMemory.test.ts`, `read.md`.

- **Reading.** Read reads the chapters once per `refresh`, beside the story, and again by itself after its own
  removal and after a chapter command it started settles. Chapter reads carry a request number, as story reads do:
  only the newest one for the chat installs its rows, its revision, or its failure, so a read that began before a
  removal cannot bring the chapter back. A failed chapters read shows the view as it is without chapters and says so
  in one line. The tab keeps the memory revision of its coverage, story, and chapters reads.
- **Layout.** The tab walks its Read rows in story order. A chapter stands where its first listed event that Read
  still lists stands, and holds the listed events Read still lists; every other row is loose, and the loose rows on
  each side of a chapter are grouped by `memoryEventGroups` separately. A loose row that falls between a chapter's
  events is placed after that chapter, and does not by itself make the chapter out of date. The whole list is newest first, the newest element open and the rest closed.
  - A chapter's heading shows its title, the first and last date among its events (`formatStoryDate`), the count of
    events, and the range of `turnsAgo`; under the heading, always visible, is the synopsis.
  - Pressing a chapter opens its events, oldest first, each as a Read row.
  - A chapter none of whose events Read lists is not shown.
- **Out of date.** The tab compares only when its coverage, story, and chapters reads carry the same memory
  revision; otherwise it shows no label and the next `refresh` settles it. With equal revisions, a chapter is out of
  date when a listed event is absent from the rows, is retracted, has a title, stored summary, and date whose
  `memoryChapterMark` differs from the listed mark, or when its listed events no longer stand in the listed order.
  The label is always derived from the chat's rows as they now are, never stored. It shows an "out of date" label
  and "Make again", which sends the remake command for that chapter and reports replaced, removed, or kept. Every
  chapter also has "Remove", which asks first.
- **The button.** "Make synopses" sits above the groups in Read. It is off while the panel is read-only and when
  the chat's memory is off (`chatMemoryEnabled`, as the panel reads it), since the command refuses such a chat. A
  press reads `/chapters/cost`. A failed read shows the failure and sends nothing. With no unit it says there is
  nothing to make yet. With one unit the press itself authorizes the one request. With two or more it asks first,
  naming the number it will send (at most 20) and, above 20, that more remain; then
  `pressMemoryChapters` in `memoryRecordPress.ts` sends the command with that number as its `limit` through
  `runServerJob`, as `pressMemoryTest` does, including its handling of a busy job it follows and of a terminal whose
  result is gone. A usable `done` result is reported in a toast as made, failed, and left; the job's own refusals
  show as its alert. A chapter request can be retried by the provider layer, so the count is of chapter requests,
  not of provider attempts.
- **The label.** `ServerJobLabel` gains `"memoryChapters"`, with `serverJob.discarded.memoryChapters` in both
  language files.
- **Search and focus.** The Reading View plan's rule for revealing an event opens a chapter that holds the event
  before it opens the event. Once the destination view is chosen, a reveal in Read keeps its target pending until
  the chapters read for this `refresh` has settled too (rows installed, or the failed read's fallback shown), since
  chapters that arrive can move the event into a closed chapter. A reveal in Manage, which reads no chapters, waits
  for nothing more than its row.
- Manage shows no chapters.
- `read.md`: Pages, Timeline, and Threads says Read joins chapters with the groups and where the out-of-date rule
  lives; Limitations says a chapter change made from another tab, or while another fence keeps the panel read-only,
  shows on the next `refresh` (C16). The component's contract comment owns the layout rules.
- Test: chapters and loose groups interleave newest first with the newest element open; the synopsis is visible on
  a closed chapter; a chapter whose first event was retracted stands at its next event; an edited title, a changed
  date, a retracted event, a missing event, and listed events in a changed order each mark a chapter out of date,
  and an unlisted row between its events does not; no label when the three reads' revisions differ; a chapters read
  that began before a removal and ends after the reread installs nothing; "Make again" sends the remake command and shows its outcome;
  "Remove" asks first and rereads; the button is off under read-only and with memory off, says so with no unit,
  sends one request without asking, asks at two naming the capped number, sends that limit, and sends nothing when
  the cost read fails; a focus on an event in a chapter opens both, also when the chapters arrive after the story,
  and a focus that lands in Manage does not wait for a chapters read;
  a failed chapters read leaves the groups.
- Manual checks: a long chat's Read view after making chapters (headings wrap on a phone-width screen, the synopsis
  is readable when closed); sending in the chat while chapters are being made is refused with a clear message and
  works again when the job ends.

## Slice 4. Chapters made as events accrue (_hard_, `structured-memory/writer.md`)

Files: `shared/structuredMemory.ts`, `server/src/jobs/jobScope.ts`, `server/src/prompt/memory/memoryTasks.ts`,
`server/src/prompt/memory/structured/chapters.ts`, `src/lib/Setting/Pages/MemorySettings.svelte`,
`src/lang/en.ts`, `src/lang/ko.ts`, `server/src/tests/memoryTasks.test.ts`,
`server/src/tests/normalizeCollections.test.ts`, `server/src/tests/memoryTaskHost.test.ts`,
`src/lib/Setting/Pages/MemorySettings.structuredMemory.test.ts`,
`src/ts/storage/tests/fixtures/boot/boot-snapshot.json`, `writer.md`.

- `StructuredMemorySettings.chapterAuto`: a boolean, default `false`, normalized like `omitUserMessages`.
  `structuredMemoryFingerprint` leaves it out, as it leaves `eventsPerGroup` out. The fresh-boot fixture and the
  normalizer suite's whole-object expectations gain the field.
- The Memory settings page gains a checkbox for it next to the group size, with one line of help: a chapter is made
  from older events as they accrue, at most one per recording, and each costs one model request. Add it to the list
  `MemorySettings.structuredMemory.test.ts` allows.
- **Where.** Only the detached writer task makes chapters by itself: `structuredWork`, when the option is on, the
  task recorded at least one window, and no window is left (it is about to end `done`, not `windowsLeft`). A task
  that ends early, a record-now press that runs inside its job, and a send that records inside its own job make
  none (C12).
- **Isolated.** The task fixes the end it is about to publish before the step starts. The step calls `makeChapters`
  with a limit of 1 on a host of its own, built for this call (`createMemoryTaskHost` from the same dependency
  factory the task's work uses) with its own abort signal, so that a failure of that host cannot reach the task's
  host or signal. Its guard is that signal with the task's epoch and source generation.
  - The signal aborts when the task stops being live and at a deadline of two minutes. The step is skipped unless
    the task's timer has more than that deadline and a margin left.
  - The task waits for the step through `untilAborted` on that signal, so the wait ends at the deadline even when a
    provider ignores the abort. A continuation that arrives later finds the guard refused and writes nothing. The
    abandoned request stays counted among the task service's outstanding work until it settles, as the wrapped
    token and regex promises are, so a drain still waits for it.
  - Whatever the step does or throws is swallowed, and the task then publishes the end it fixed. A task cancelled
    from outside during the step ends as a cancelled task does today.
  - A failed unit makes no chapter and the next recording tries again; the cleanup of orphan chapters that the
    maker's first step already made stays.
- `writer.md`: the writer task says where the step runs, how it is isolated, and that it cannot change the task's
  end; the preset fields and the fingerprint's exceptions name the field; Limitations says a failure is silent and
  which recordings make no chapter.
- Test: with the option off nothing is called; with it on, a task that recorded a window with none left makes one
  chapter when a unit is ready and none when not; a task that recorded nothing, and one ending `windowsLeft`, make
  none; a failed reply, a host failure, a request still out at the deadline, and a provider that ignores the abort
  each leave the task `done` with its usual reason, and the late answer writes no chapter; a task with too little
  of its timer left skips the step; a task cancelled during the request ends as a cancelled task does today; the normalizer and the
  fingerprint cases as for `eventsPerGroup`; the settings checkbox writes only the selected preset.
- Manual checks: with the option on, a long real chat gains one chapter per recording until it has caught up.

## Slice 5. Rebuilds drop chapters, copies carry them (_hard_, `structured-memory/lifecycle.md`, `rebuild.md`)

Files: `server/src/data/memoryStore.ts`, `server/src/data/resourceStore.ts`,
`server/src/routes/structuredMemory.ts`, `server/src/tests/memoryStore.test.ts`,
`server/src/tests/memoryTasks.test.ts`, `server/src/tests/structuredMemoryRoutes.test.ts`, `lifecycle.md`,
`rebuild.md`.

- **Rebuild.** The inner `swap` deletes the chat's chapters with its own statement, inside the transaction it
  already runs in, from the run's chat sequence and stored mode: every mode but `backfill`, whose folds keep ids
  and text (C5). No flag is passed in and no public mutator is called there. A failure of that statement rolls the
  swap back with everything else.
- **Copies and branches.** `store.memory.chapters.copy(characterId, sourceChatId, chatId, epoch)` inserts into the
  target, under fresh chapter ids and with the marks as they are, each source chapter all of whose listed events
  exist in the target, whatever their status or text now is, and none of whose events a chapter of the target
  already lists. The marks cross unchanged and the newest-ten rule, which governs making, does not apply to
  carrying (C10); whether the copy reads as out of date is derived in the target from its own rows. The inherit
  route calls it right after its `store.memory.write`, with no `await` between, and catches its failure: the
  inheritance answer is unchanged, and the target then has fewer chapters or none.
- **Checkpoints.** A load leaves the chapter rows as they are. The tab's comparison then decides each chapter from
  its events as they now are: one made after the checkpoint stays current when its events, their text and dates,
  and their order were the same at capture, and is out of date or hidden otherwise. The maker's first step removes one whose events are all
  gone. No code changes for this; `lifecycle.md` records it.
- `rebuild.md`: The swap and What a rebuild keeps name the chapters. `lifecycle.md`: Copies and branches, and a
  Limitations entry for checkpoints, chat files, the package, and a restored database (C9).
- Test: a rebuild's swap and a fresh rebuild's swap leave no chapter, and a refused swap leaves them; a backfill's
  swap keeps them; a branch that carries all of a chapter's events gets the chapter under a new id with its marks,
  also when one of those events is retracted or edited; a branch that cuts through a chapter does not get it; an
  inheritance into a chat that already holds rows copies nothing, as today; an inheritance into a chat that holds
  only chapter rows (a checkpoint with empty memory loaded into a chat that had inherited) does not put one event
  into two chapters; a failing copy leaves the inheritance answer as it was.

## Decisions

The owner accepted C1 to C7 on 2026-11-18. C8 to C16 are this plan's own; the owner read the draft the same day and
accepted the defaults of the four that change what a person sees or pays: C8, C10, C11, and C12. The audit of
2026-11-18 then narrowed C9, C11, and C12 to what the code can do; the owner has not yet read those three as
narrowed.

- C1. Chapters are for display. Nothing puts them into the prompt in this plan, but a chapter keeps the list of
  events it was made from, so a later plan can use them without a new record shape. The earlier Recent Timeline
  plan left chapter summaries in the prompt out of scope, and that stands.
- C2. A "Make synopses" button, and automatic making as a preset checkbox, off by default.
- C3. The newest events never enter a new chapter, and how many is a fixed number, not an option, to begin with.
- C4. A chapter whose events changed is labelled out of date and can be made again. Nothing regenerates by itself.
- C5. A rebuild and a fresh rebuild delete the chat's chapters.
- C6. One level only. A synopsis of synopses, or one "story so far" text above the chapters, waits until chapters
  have been used.
- C7. `eventsPerGroup` is the target size of a chapter. A chapter keeps its events, so changing the option applies
  to chapters made afterwards.
- C8. The fixed number of C3 is 10 events.
- C9. Chapters live in a table outside the restore's group. A restore, an import, a chat file, the Markdown
  package, and a checkpoint do not carry them, and they are made again where those are used. A native snapshot and
  the SQLite payload of a native backup archive are copies of the whole database, so they hold the rows; a restore
  does not read them, and the upstream-compatible export does not write them. This keeps every closed list an older
  build checks unchanged, and an older build opening the database ignores the table.
- C10. A copy or a branch carries the chapters whose events all crossed, as they are, so branching a long chat does
  not cost the requests again.
- C11. The button runs as a command job, like the writer's test run: it holds the chat's slot until it ends and is
  refused for a plugin model or a request trigger, for a chat whose memory is off, and while the writer is working.
  The server tells the tab how many requests are due; a press authorizes one request by itself and asks before two
  or more, capped at 20 per press; and the server sends no more than the number authorized.
- C12. Automatic making adds at most one request to a recording, and its failure is silent. It runs only after the
  detached writer task; a recording that runs inside a job (a record-now press that needs the tab, or a server
  without the task service) makes none.
- C13. A chapter made in the ordinary way covers from `eventsPerGroup` events to twice that less one, always whole
  date groups or whole parts of a long day. What closes a gap before an existing chapter can be shorter.
- C14. A change is detected by a hash of each event's title, summary, and story date, stored with the chapter, and
  by the order of the listed events, both compared in the tab when its reads agree on the memory revision. It is
  not a security measure.
- C15. A chapter write does not move the memory revision, so it never makes a panel edit or a writer commit retry.
  The maker instead re-derives its unit from the store immediately before each write, under a guard on the
  caller's signal, the epoch, and the chat's source generation.
- C16. A tab rereads chapters after its own chapter actions and on the panel's `refresh`. A change made from another
  tab, or one that lands while another fence keeps the panel read-only, shows on the next `refresh`.

## Not In This Plan

- Chapters in the prompt, in the HypaV3 projection, or in the context report.
- A second level over chapters, and one "story so far" text.
- Editing a chapter's title or synopsis by hand, and merging or splitting chapters.
- Carrying chapters through a restore, chat files, the Markdown package, or checkpoints, and removing their rows
  from snapshot and backup files.
- An option for the number of newest events kept out of chapters.
- A cost estimate in tokens for the button; it names the number of requests.
- Automatic chapters from a recording that runs inside a job.
- A background queue for the button's work, and a live signal that tells every open panel a chapter changed.
- Searching the original messages from the memory panel, proposed as its own session on 2026-11-18.

## Open Questions

None open. The owner answered C1 to C7 and accepted the defaults of C8, C10, C11, and C12 on 2026-11-18. The
alternatives the owner passed over: leaving chapters behind on a copy or a branch (C10), a queued background task
for the button in place of a command job that holds the chat's slot (C11), and a line in the panel's writer status
for a failed automatic chapter (C12).
