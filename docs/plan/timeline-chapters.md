# Timeline Chapter Synopses Plan

Status: drafted 2026-11-18 at `de5357ca5` from the owner's request; the owner accepted C1 to C7 the same day and the
defaults of C8, C10, C11, and C12 after reading the draft (Decisions). Not audited yet. Starts after
[Timeline Reading View](timeline-reading.md) lands: it builds on that plan's Read view, `memoryEventGroups`, and
`eventsPerGroup`. Landed: none.

Sources: the owner's request and answers (2026-11-18: re-summarize runs of events into synopses, a structure the
owner once built as a whole-story memory, now to show a person the story; a button to make them and a checkbox for
making them automatically; the latest events stay out, since settled history is rarely edited); the owner's reference
`process/summary.py` (leaf summaries re-summarized into past summaries, which are merged again); the store, the
routes, the writer, the memory task service, and the lifecycle code under `server/src/data/`,
`server/src/routes/structuredMemory.ts`, `server/src/prompt/memory/`, and `server/src/jobs/`, read at `de5357ca5`;
the [structured memory guides](../structure/structured-memory/README.md). Seven read-only research workers gathered
the anchors and the session re-read the ones a slice rests on (`CHAT_OPEN_SCHEMA_SQL`, `rebuild.swap`,
`swapRebuild`, `runMemoryTest`, `structuredWork`, `runMemoryRecord`, `projectChatMemory`, the inherit route, the
writer's `call`). Identifiers are the anchors; re-verify each cited location before editing (STRUCTURE.md protocol
step 5).

## Goal

A long chat's older events read as chapters: a title and a synopsis over a run of events, in the Timeline's Read
view, with the events one press below.

- **A guide to the place, not the answer.** A chapter tells a person where in the story something happened; the
  events, their key lines, and the original messages below it still answer "did this happen?".
- **Made on request.** A button makes the chapters that are missing; a preset option makes them as events accrue.
- **Settled history only.** The newest events never enter a chapter.
- **Honest when stale.** A chapter whose events changed says so and offers to be made again; nothing regenerates on
  its own.

Not goals: putting chapters into the prompt (C1); a second level that summarizes chapters (C6); carrying chapters
through snapshots, chat files, the Markdown package, or checkpoints (C9).

## Current State

- A chat's memory records are `pages`, `events`, `threads`, and `runs` (`MEMORY_RECORD_KINDS`), stored in the five
  tables of `MEMORY_TABLES_SQL` (`server/src/data/chatStore.ts`), which snapshots treat as one optional group: all
  absent is accepted, a subset is refused, and each present table must have exactly the expected columns. The
  snapshot walk, the restore sink, and `copyStagedMemory` enumerate those tables; a table outside the group is
  neither walked nor copied, and a restore deletes the live chats first, so rows keyed to `chats.seq` with
  `ON DELETE CASCADE` go with them.
- `memory_event_sources` is the precedent for a derived table outside the group: it is created by
  `CHAT_OPEN_SCHEMA_SQL`, which `openChatSchema` runs at every open, with no `SCHEMA_VERSION` change.
- `store.memory.write` checks the base revision and the epoch, validates the whole change set, and moves
  `memory_state.revision` once. Checkpoint manifests, chat files, the package, and inheritance each list the record
  kinds they carry; none has a slot for another kind, and an older build checks `MEMORY_RUN_RESULTS` and
  `MEMORY_HISTORY_CHANGE_KINDS` as closed lists.
- An event's title or summary changes in place through the panel's `eventText` edit and through a checkpoint load,
  which restores older rows under the same ids. A re-record leaves the old id retracted and commits a new id
  (`retireRerecorded`). A rebuild removes the live events it replaces and installs staged ids; a fresh rebuild
  removes every live event; a backfill's folds keep ids and text. An event has no revision of its own:
  `createdRevision` is stamped once, and `/coverage` sends no summary.
- `projectChatMemory` (`server/src/data/memoryStore.ts`) places events by their earliest current message position,
  a greeting citation at -1 and an event no message places last, before it projects them; that placement is the
  server's only "events in message order".
- Compaction is the model for an extra writer call: a code-owned frame that `fineTuning` never replaces
  (`compactSlots`, `compactRules` in `prompts.ts`), the preset's `instructions` appended under the same clamp, the
  language from the writer's `writerLanguage`, `answerJson` for the answer, and a failure that is a warning. It runs
  inside a writer run, through the run's `call` wrapper over `host.request`.
- `runMemoryTest` (`testRun.ts`) is the model for a panel-started model call that records no run: a `command` job
  (`GenerationCommand` in `shared/jobs.ts`, dispatched by `createGenerationRunner`), admitted by `admitRecord`,
  refused when `jobMemoryBlockingReason` names a tab-dependent model or trigger or when the chat's memory task is
  queued or running, with a host from `createMemoryTaskHost` over `detachedHostDeps`, the job's signal as its fence,
  and its result in the job's `done`. The job holds the chat's slot while it runs.
- The detached writer task finishes its windows in `structuredWork` (`memoryTasks.ts`), and a record-now press that
  must stay in the job in `recordInJob` (`recordJob.ts`). The service's queue holds one running task and one pending
  input per chat, and a newer hand-off replaces the pending one.
- `swapRebuild` (`memoryTasks.ts`) knows the rebuild's mode and calls `store.memory.rebuild.swap`, whose inner
  `swap` (`memoryStore.ts`) writes the changes, copies the staged runs, and removes the run in one transaction.
- The inherit route builds the target's records with `inheritedRecords`, which keeps event ids, and writes them
  with one `store.memory.write`.
- The panel's `refresh` moves when its read-only state falls, which a finished command job and a finished memory
  task both cause, so a tab rereads after either.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_.

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused command
  `pnpm --silent test:agent structuredMemory StructuredMemory memory/structured memoryStore memoryTasks memoryJobs MemorySettings normalizeCollections memoryTaskHost`,
  then `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, and `pnpm check:docs`
  for a guide edit. Run `pnpm check` again after the last test edit. V4 and V6 as the repository states them.
- **Outside the record set.** A chapter is not a memory record kind. It never enters `MEMORY_RECORD_KINDS`,
  `MemoryChanges`, the prompt, the HypaV3 projection, the package, a chat file, a checkpoint manifest, or the
  snapshot group, and a chapter write never moves `memory_state.revision`.
- **Never in the way.** No chapter failure fails a writer run, a rebuild, a send, or a panel read. A chat with no
  chapter behaves exactly as it does today.
- **Strings.** New user-visible text goes in `src/lang/en.ts` under `structuredMemory`, with its Korean in
  `src/lang/ko.ts` in the same slice. The Korean for a chapter is 장 and for its text 줄거리.
- **Plain text.** A chapter's title and synopsis are rendered as text, never as Markdown or HTML.
- **Persisted values.** A new preset or wire field is optional, and absent means today's behavior.
- **Guide.** Each slice names its guide and updates the sections that name a changed contract; a guide stays under
  the 40,000-byte ceiling (`read.md` has the least room). Comments and test titles describe behavior, not this plan.
- **Tests.** Routes in `server/src/tests/structuredMemoryRoutes.test.ts`, the store in
  `server/src/tests/memoryStore.test.ts`; the
  job on a real stack in `server/src/tests/memoryJobs.test.ts`; the task in `server/src/tests/memoryTasks.test.ts`;
  pure rules beside their module; the panel in `StructuredMemoryPanel.test.ts`; the tab client in
  `src/ts/process/structuredMemory.test.ts`.
- **Manual checks.** Each slice lists the browser, device, and real-model checks it cannot run; what is unrun when
  the plan closes moves to [manual checks](../backlog/manual-checks.md) under this plan's name.

## Order

1 → 2 → (3 ∥ 5) → 4. Slice 1 gives the record, the store, and the routes every later slice uses. Slice 2 gives the
maker that slices 3 and 4 start. Slices 3 and 5 share no file: slice 3 edits `TimelineTab.svelte`, the language
files, `structuredMemory.svelte.ts`, `memoryRecordPress.ts`, the panel test, and `read.md`; slice 5 edits
`memoryStore.ts`, `memoryTasks.ts`, `server/src/routes/structuredMemory.ts`, their tests, `lifecycle.md`, and
`rebuild.md`. Slice 4 is last because it edits `memoryTasks.ts` after slice 5 and the language files after slice 3.
If the run stops early, slices 1 to 3 stand alone as chapters made by the button.

## Slice 1. The chapter record, its table, and its routes (_hard_, `structured-memory/records.md`)

Files: `shared/structuredMemory.ts`, a test beside it under `shared/tests/`, `server/src/data/chatStore.ts`,
`server/src/data/memoryStore.ts`, `server/src/data/resourceStore.ts`, `server/src/routes/structuredMemory.ts`,
`src/ts/process/structuredMemory.svelte.ts`, `server/src/tests/structuredMemoryRoutes.test.ts`,
`server/src/tests/memoryStore.test.ts`, `src/ts/process/structuredMemory.test.ts`, `records.md`.

- **The record.** `MemoryChapter` is `{ id, title, synopsis, events }`, where `events` is the list, in story order,
  of `{ id, mark }` for each event the chapter was made from. The title is at most
  `STRUCTURED_MEMORY_LIMITS.eventTitleChars`; the synopsis at most a new `chapterSynopsisChars` (1,200).
- **The mark.** `memoryChapterMark(title, summary)` in `shared/structuredMemory.ts` is a synchronous, deterministic,
  non-cryptographic hash of an event's title and summary, the same in the tab and on the server. It detects a
  change; it protects nothing (C14).
- **The units.** `memoryChapterUnits(events, size, recent)` in `shared/structuredMemory.ts` is the one rule for
  which events a new chapter covers. Its input is the chat's events in story order, each with an id, an optional
  date, and whether a chapter already lists it; retracted events and events no message places are left out before
  the call and never count.
  - The newest `recent` events (`STRUCTURED_MEMORY_LIMITS.chapterRecentEvents`, 10) are never in a unit (C3, C8).
  - Among the rest, each run of events between chapters is grouped by `memoryEventGroups(run, size)`; whole groups
    are gathered, oldest first, until a unit holds `size` events or more, so a unit holds from `size` to twice
    `size` less one.
  - What is left at the end of a run waits when the run ends at the newest events, and forms a unit of its own when
    the run ends at an existing chapter, so a gap between chapters always closes.
- **The table.** `memory_chapters` (`seq` autoincrement, `chatSeq` referencing `chats(seq)` with
  `ON DELETE CASCADE`, `id`, `data` as stored JSON, unique `(chatSeq, id)`, strict) is created by
  `CHAT_OPEN_SCHEMA_SQL`, outside `MEMORY_TABLES_SQL` and the snapshot group, as `memory_event_sources` is. No
  `SCHEMA_VERSION` change.
- **The store.** `store.memory.chapters`, checked against the epoch as other memory writes are:
  - `list(characterId, chatId)`: the chat's chapters in `seq` order.
  - `add(characterId, chatId, epoch, chapter)`: in one synchronous step, refuses unless every listed event exists,
    is not retracted, has the listed mark, and is in no other chapter; then inserts. It never moves
    `memory_state.revision`.
  - `remove(characterId, chatId, epoch, ids)` and `clear(characterId, chatId)`.
- **The routes**, beside the other memory routes and under their authentication, rate limit, and epoch check:
  - `GET .../chapters` answers the chapters in rounds charged by stored bytes, as `/story` is, with the memory
    revision of the read.
  - `POST .../chapters/remove` with `{ ids }` removes those chapters; it is refused while the chat's write fence is
    up, as an edit is.
- **The tab client.** `readStructuredMemoryChapters` reads every round and gives the tab well-shaped rows only, as
  `readStructuredMemoryStory` does; `removeStructuredMemoryChapters` posts the removal.
- `records.md`: Memory tables gains the table and that it is outside the group and every lifecycle walk; the read
  routes gain `/chapters`; Limitations says what does not carry chapters (C9).
- Test:
  - `memoryChapterMark`: equal for equal text, different when the title or the summary differs.
  - `memoryChapterUnits`: the newest ten never enter; a unit closes at `size` on a group boundary; a long day cut
    into parts yields units of whole parts; the tail waits at the open end and closes before a chapter; a covered
    event starts a new run; retracted and unplaced events are ignored.
  - Store: `add` refuses a missing event, a retracted one, a changed mark, and an event another chapter lists, and
    leaves the memory revision as it was; deleting the chat removes its chapters; a snapshot written with chapters
    restores with none and is not refused; an open of a database from before the table creates it.
  - Routes: `/chapters` pages by bytes and refuses a missing chat; `remove` removes, refuses under the fence, and
    refuses a stale epoch.

## Slice 2. The chapter call and its command (_hard_, `structured-memory/writer.md`)

Files: new `server/src/prompt/memory/structured/chapters.ts` and its test,
`server/src/prompt/memory/structured/prompts.ts` and its test, `server/src/prompt/memory/structured/writer.ts`
(exports only), `server/src/data/memoryStore.ts` (the ordering helper), `server/src/jobs/commandRunner.ts`,
`shared/jobs.ts`, `shared/structuredMemory.ts`, `server/src/tests/memoryJobs.test.ts`, `writer.md`.

- **Order.** Lift the placement and sort of `projectChatMemory` into a helper that returns a chat's stored events
  in current message order with each one's position, and have `projectChatMemory` use it, its output unchanged.
- **The frame.** `chapterSlots({ language, events })` in `prompts.ts` builds a code-owned frame, never replaced by
  `fineTuning`, with the preset's `instructions` appended as compaction appends them. It lists each event's story
  date, title, and summary in order and asks for `{ "title", "synopsis" }` in the given language: a title within
  the title limit, and a synopsis within `chapterSynopsisChars` that says only what the events say, keeps names and
  the dates the events name, and uses no wording relative to the reading day. The language is the writer's, so
  `writerLanguage` (or what it reads) is exported for this caller.
- **The answer.** `readChapter(text)` parses with `answerJson`, refuses a blank title or synopsis, and clamps
  either to its limit.
- **The maker.** `makeChapters({ store, scope, host, chatRef, limit, signal })` in `chapters.ts`:
  1. removes the chapters none of whose events exists unretracted any more;
  2. reads the events in message order, the chapters, and the chat's `eventsPerGroup`, and takes the units of
     `memoryChapterUnits`, oldest first, at most `limit`;
  3. for each unit, checks the signal, builds the frame, calls `host.request`, reads the answer, and adds the
     chapter with the marks of the events as the frame read them. A refused add (an event changed meanwhile) and a
     failed or unusable answer count as failed and the maker goes on to the next unit;
  4. returns `{ made, failed, left }`, where `left` is the units beyond `limit`.
     A thrown host failure ends the maker and is the caller's to report; chapters already added stay.
- **The command.** `{ type: "memoryChapters" }` joins `GenerationCommand`; `createGenerationRunner` dispatches it
  to `runMemoryChapters` in `chapters.ts`, built as `runMemoryTest` is: `admitRecord`, the refusals for a
  tab-dependent model or trigger and for a queued or running memory task, a host from `createMemoryTaskHost` over
  `detachedHostDeps`, the job's signal as the fence, and `makeChapters` with a limit of 20 calls. Its `done` carries
  `{ kind: "memoryChapters", made, failed, left }`. A job refused during a rebuild stays refused by the job
  admission as it is today.
- `writer.md`: a section for the chapter call beside Compaction (the frame's rule, the language, what a failure
  does, that it writes no run); Files gains `chapters.ts`.
- Test:
  - `prompts.test.ts`: the frame names the language, carries the instructions, lists the events in order, and is
    the default frame with `fineTuning` on.
  - `chapters.test.ts`, with a scripted host: one chapter per unit with the marks of what was read; a blank answer
    and unparseable text count as failed and write nothing; an event edited between the read and the add leaves no
    chapter for that unit; the limit leaves the rest counted; an aborted signal stops before the next call; an
    orphan chapter is removed first.
  - `memoryJobs.test.ts`, on a real stack: the command makes chapters and reports them in `done`; it is refused
    while a memory task is queued and for a plugin model; `projectChatMemory`'s existing cases pass unchanged.
- Manual checks: with a real model, a made chapter reads as a fair synopsis of its events in the chat's recorded
  language.

## Slice 3. Chapters in the Read view, and the button (_hard_, `structured-memory/read.md`)

Files: `TimelineTab.svelte`, `src/lib/Others/StructuredMemory/memoryRecordPress.ts`,
`src/ts/process/structuredMemory.svelte.ts`, `src/lang/en.ts`, `src/lang/ko.ts`, `StructuredMemoryPanel.test.ts`,
`src/ts/process/structuredMemory.test.ts`, `read.md`.

- **Reading.** Read reads the chapters once per `refresh`, beside the story. A failed chapters read shows the view
  as it is without chapters and says so in one line.
- **Layout.** A chapter takes the place of the groups its events would form, at the position of its first listed
  event; the events no chapter lists are grouped by `memoryEventGroups` as before. The whole list is newest first,
  the newest element open and the rest closed.
  - A chapter's heading shows its title, the first and last date among its events (`formatStoryDate`), the count of
    events, and the range of `turnsAgo`; under the heading, always visible, is the synopsis.
  - Pressing a chapter opens its events, oldest first, each as a Read row.
  - A chapter none of whose events Read lists is not shown.
- **Out of date.** A chapter is out of date when a listed event is absent from the tab's rows, is retracted, or has
  a title and stored summary whose `memoryChapterMark` differs from the listed mark. It shows an "out of date" label
  and "Make again", which removes the chapter and then starts the command. Without a successful story read nothing
  is compared and no label is shown. Every chapter also has "Remove", which asks first.
- **The button.** "Make synopses" sits above the groups in Read. The tab counts the units with `memoryChapterUnits`
  over its own rows and its chat's `eventsPerGroup`; the button is off when there is none or the panel is read-only.
  A press of two calls or more asks first and names the count. `pressMemoryChapters` in `memoryRecordPress.ts` sends
  the command through `runServerJob`, as `pressMemoryTest` does, and reports made, failed, and left in a toast; the
  job's own refusals show as its alert. The panel's `refresh` moves when the job ends, which rereads the chapters.
- **Search and focus.** An event inside a chapter that a search hit or a `focus` names opens its chapter, then the
  event.
- Manage shows no chapters.
- `read.md`: Pages, Timeline, and Threads says Read joins chapters with the groups and where the out-of-date rule
  lives; the component's contract comment owns the layout rules.
- Test: chapters and loose groups interleave newest first with the newest element open; the synopsis is visible on
  a closed chapter; an edited event's title marks its chapter out of date, and so do a retracted and a missing
  event; no label without a story read; "Make again" removes then starts the command; "Remove" asks first; the
  button is off with no unit and under read-only, asks at two calls, and sends the command; a focus on an event in
  a chapter opens both; a failed chapters read leaves the groups.
- Manual checks: a long chat's Read view after making chapters (headings wrap on a phone-width screen, the synopsis
  is readable when closed); sending in the chat while chapters are being made is refused with a clear message and
  works again when the job ends.

## Slice 4. Chapters made as events accrue (_hard_, `structured-memory/writer.md`, `settings-i18n.md`)

Files: `shared/structuredMemory.ts`, `server/src/jobs/jobScope.ts`, `server/src/prompt/memory/memoryTasks.ts`,
`server/src/prompt/memory/structured/recordJob.ts`, `server/src/prompt/memory/structured/chapters.ts`,
`src/lib/Setting/Pages/MemorySettings.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`,
`server/src/tests/memoryTasks.test.ts`, `server/src/tests/memoryJobs.test.ts`,
`server/src/tests/normalizeCollections.test.ts`, `server/src/tests/memoryTaskHost.test.ts`,
`src/lib/Setting/Pages/MemorySettings.structuredMemory.test.ts`, `writer.md`.

- `StructuredMemorySettings.chapterAuto`: a boolean, default `false`, normalized like `omitUserMessages`.
  `structuredMemoryFingerprint` leaves it out, as it leaves `eventsPerGroup` out.
- The Memory settings page gains a checkbox for it next to the group size, with one line of help: a chapter is made
  from older events as they accrue, at most one per recording, and each costs one model call. Add it to the list
  `MemorySettings.structuredMemory.test.ts` allows.
- When the option is on, `structuredWork` (after its last window recorded, before it ends the task) and
  `recordInJob` (after its windows, before the job's `done`) call `makeChapters` with a limit of 1 and their own
  host. Every outcome but an abort is swallowed: a failure writes nothing, changes neither the task's nor the job's
  end, and the next recording tries again (C12). A task that ends early (`skipped`, `failed`, `windowsLeft`) makes
  no chapter. No other caller of the writer makes chapters.
- `writer.md`: the writer task and Record now say where the step runs and that it cannot fail them; Limitations
  says a failure is silent and that a send recording inside its own job makes none.
- Test: with the option off nothing is called; with it on, a task that recorded its windows makes one chapter when
  a unit is ready and none when not; a failing chapter call leaves the task `done` with its usual reason; a task
  ending `windowsLeft` makes none; the record job does the same in-job; the normalizer and the fingerprint cases as
  for `eventsPerGroup`; the settings checkbox writes only the selected preset.
- Manual checks: with the option on, a long real chat gains one chapter per recording until it has caught up.

## Slice 5. Rebuilds drop chapters, copies carry them (_hard_, `structured-memory/lifecycle.md`, `rebuild.md`)

Files: `server/src/data/memoryStore.ts`, `server/src/data/resourceStore.ts` if the swap's wrapper needs the flag,
`server/src/prompt/memory/memoryTasks.ts`, `server/src/routes/structuredMemory.ts`,
`server/src/tests/memoryTasks.test.ts`, `server/src/tests/structuredMemoryRoutes.test.ts`, `lifecycle.md`,
`rebuild.md`.

- **Rebuild.** The swap of a `rebuild` or a `fresh` rebuild deletes the chat's chapters in the swap's transaction;
  a `backfill`, whose folds keep ids and text, keeps them (C5). `swapRebuild` passes the mode's choice to
  `store.memory.rebuild.swap`.
- **Copies and branches.** After the inherit route's write, it copies to the target each source chapter all of
  whose events crossed with the listed marks, through `store.memory.chapters.add`, under fresh chapter ids. A
  chapter that does not qualify is left behind, and a failed copy leaves the target without that chapter and the
  inheritance as it was (C10).
- **Checkpoints.** A load leaves the chapter rows as they are. The marks then show a chapter made after the
  checkpoint as out of date, and the maker's first step removes one whose events are all gone. No code changes for
  this; `lifecycle.md` records it.
- `rebuild.md`: The swap and What a rebuild keeps name the chapters. `lifecycle.md`: Copies and branches, and a
  Limitations entry for checkpoints, chat files, the package, and a restored snapshot (C9).
- Test: a rebuild's swap and a fresh rebuild's swap leave no chapter, and a refused swap leaves them; a backfill's
  swap keeps them; a branch that carries all of a chapter's events gets the chapter under a new id, and one that
  cuts through a chapter does not; an inheritance into a chat that already holds rows copies nothing, as today.

## Decisions

The owner accepted C1 to C7 on 2026-11-18. C8 to C15 are this plan's own; the owner read the draft the same day and
accepted the defaults of the four that change what a person sees or pays: C8, C10, C11, and C12.

- C1. Chapters are for display. Nothing puts them into the prompt in this plan, but a chapter keeps the list of
  events it was made from, so a later plan can use them without a new record shape. The earlier Recent Timeline
  plan left chapter summaries in the prompt out of scope, and that stands.
- C2. A "Make synopses" button, and automatic making as a preset checkbox, off by default.
- C3. The newest events never enter a chapter, and how many is a fixed number, not an option, to begin with.
- C4. A chapter whose events changed is labelled out of date and can be made again. Nothing regenerates by itself.
- C5. A rebuild and a fresh rebuild delete the chat's chapters.
- C6. One level only. A synopsis of synopses, or one "story so far" text above the chapters, waits until chapters
  have been used.
- C7. `eventsPerGroup` sets how many events a chapter covers. A chapter keeps its events, so changing the option
  applies to chapters made afterwards.
- C8. The fixed number of C3 is 10 events.
- C9. Chapters live in a table outside the snapshot group. They are not in snapshots, restores, chat files, the
  Markdown package, or checkpoints, and are made again where those are used. This keeps every closed list an older
  build checks unchanged, and a database opened by an older build simply ignores the table.
- C10. A copy or a branch carries the chapters whose events all crossed, so branching a long chat does not cost the
  calls again.
- C11. The button runs as a command job, like the writer's test run: it holds the chat's slot until it ends, makes
  at most 20 chapters per press, and is refused for a model or trigger that needs the tab.
- C12. Automatic making adds at most one call to a recording, and its failure is silent.
- C13. A chapter covers from `eventsPerGroup` events to twice that less one, always whole date groups or whole
  parts of a long day.
- C14. A change is detected by a hash of each event's title and summary, stored with the chapter and compared in
  the tab. It is not a security measure.
- C15. A chapter write does not move the memory revision, so it never makes a panel edit or a writer commit retry.

## Not In This Plan

- Chapters in the prompt, in the HypaV3 projection, or in the context report.
- A second level over chapters, and one "story so far" text.
- Editing a chapter's title or synopsis by hand, and merging or splitting chapters.
- Carrying chapters in snapshots, chat files, the Markdown package, or checkpoints.
- An option for the number of newest events kept out of chapters.
- A cost estimate in tokens for the button; it names the number of calls.
- Making chapters from a send that records inside its own job.
- Searching the original messages from the memory panel, proposed as its own session on 2026-11-18.

## Open Questions

None open. The owner answered C1 to C7 and accepted the defaults of C8, C10, C11, and C12 on 2026-11-18. The
alternatives the owner passed over: leaving chapters behind on a copy or a branch (C10), a queued background task
for the button in place of a command job that holds the chat's slot (C11), and a line in the panel's writer status
for a failed automatic chapter (C12).
