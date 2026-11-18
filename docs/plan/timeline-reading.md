# Timeline Reading View Plan

Status: drafted 2026-11-18 at `de5357ca5` from the owner's request; the owner accepted D1 to D7 the same day
(Decisions); audited the same day by a read-only GPT-6.2-Astra session in `full` mode, at the owner's request in
place of plan-runner's own audit ([report](../reports/audits/plan-runner/timeline-reading-2026-11-18.md): one P1,
seven P2, and thirteen P3, all fixed in this text). The report and this line share the plan's last commit, so a
plan-runner run skips its Plan audit unless the plan changes again. Landed: 1 (`9dd66b47a`).

Sources: the owner's request and answers (2026-11-18: the Timeline lists the oldest event first, and as turns pile up
it reads as a log viewer for the data the model uses, not as a page a person refers to; the most frequent use is
checking "did this happen?" and "did I say that then?"); `TimelineTab.svelte`, `PagesTab.svelte`, `CoverageTab.svelte`
and `StructuredMemoryPanel.svelte` under `src/lib/Others/StructuredMemory/`, `memoryTimelineRows` and
`readStructuredMemoryStory` in `src/ts/process/structuredMemory.svelte.ts`, the `/story` and `/find` rounds in
`server/src/routes/structuredMemory.ts`, `normalizeStructuredMemorySettings` in `shared/structuredMemory.ts`, and
`structuredMemoryFingerprint` in `server/src/jobs/jobScope.ts`, read at `de5357ca5`; the
[structured memory guides](../structure/structured-memory/README.md). Seven read-only research workers gathered the
anchors and the session re-read the ones a slice rests on. Identifiers are the anchors; re-verify each cited location
before editing (STRUCTURE.md protocol step 5).

The chapter synopses that sit on top of this view are a separate plan,
[Timeline Chapter Synopses](timeline-chapters.md), which starts after this one lands.

## Goal

The Timeline tab becomes a page a person reads and looks things up in, with the checking and repair tools one click
away instead of mixed into every row.

- **Read first.** The tab opens on a reading view: events in groups by the story's date, the newest group on top,
  each group read in story order, with the summary on the row.
- **Checkable.** Opening an event shows its key lines and the links to the original messages, which is how "did I
  say that?" is answered.
- **Findable.** The memory text search is in the Timeline itself.
- **Nothing lost.** Every badge, repair, and edit of today's Timeline stays, in a Manage view.

Not goals: any change to what a send selects, to the writer, or to stored records; chapter synopses; a search of the
original messages (its own session, proposed on 2026-11-18).

## Current State

- `TimelineTab.svelte` holds `view: "titles" | "story"`, default `"titles"`, behind a `SegmentedControl` labelled by
  `language.structuredMemory.timeline.views` (`{ titles, story }` in `src/lang/en.ts` and `src/lang/ko.ts`). Story
  reads `/story` once per `refresh` (`readStory`, guarded by `storyRead`), joins summaries by event id, and hides
  retracted events; Titles reads no story.
- Rows come from `memoryTimelineRows(reconciled.events, messages)`, which sorts ascending by the first surviving
  message, then by the stored position, then last (`position: Infinity`), with a greeting citation at -1. The oldest
  event is therefore the first row, and `ROWS_AT_ONCE = 200` with "show more" puts the newest events of a long chat
  behind several presses.
- Each row shows the title, `turnsAgo`, and the badges `stale`, `rerecord`, `suppressed`, and used-in-last-send. One
  event opens at a time (`openId`); opening reads its record (`readOpen`) and shows the edit control, the summary,
  the story time, participants, key lines, `MemoryEventFacts`, the source links, and, for a stale event, the repairs.
- `StructuredMemoryStoryEvent` is `Pick<MemoryEvent, "id" | "summary" | "storyTime" | "participants">`. The `/story`
  round projects those four named fields as stored, retracted events included; the route test asserts four keys on
  fully populated fixtures ("serves story in stored-byte rounds including retracted events with exactly four stored
  fields"), and the client reader tolerates rows that lack some. The reader keeps a `storyTime.date` only when
  `isStoryDate` accepts it and builds its rows from the fields it names.
- `MemoryEvent.grade` is optional, 0 to `STRUCTURED_MEMORY_LIMITS.gradeMax` (9). The writer stores the sum of the
  three axes only when they are complete; a restored chat file can carry any finite number, so slice 1 validates
  the value before the Timeline sees it. `STRUCTURED_MEMORY_LIMITS.importantEventGrade` is 6, which Pages uses for its "important" badge and
  the HypaV3 projection for its important mark.
- `formatStoryDate` renders a `MemoryStoryDate` as `YYYY-MM-DD` or, without a year, `MM-DD`. No helper compares two
  dates for equality or order; `storyDateDistance` is anchor-relative.
- `PagesTab.svelte` has the Read/Manage split this plan copies (`view`, default `"read"`, `text.views.read` and
  `text.views.manage`) and the only text search box: `searchText` calls `findStructuredMemory(ref, { q })` on submit,
  never while typing, rejects an answer when the request number, the chat, `refresh`, or the query moved, reruns an
  active query on `refresh`, and renders page and event hits. An event hit calls
  `open({ tab: "timeline", id: hit.id })`. `/find` matches an event's summary, then its key lines, then its title,
  and skips retracted events.
- `StructuredMemorySettings` (`shared/structuredMemory.ts`) is normalized by `normalizeStructuredMemorySettings`:
  unknown keys are dropped, and `integerIn` returns the fallback for a value outside its range. A tab reads the
  chat's preset as `CoverageTab.svelte` does, through `chatHypaV3Preset(settings.hypaV3Presets.items,
settings.hypaV3Presets.selectedId, chatEntry(chatRef))`. `structuredMemoryFingerprint` digests the `structured`
  object without `highlightMode`, `highlightKinds`, and `highlightChangeGrade`; any other field changes the digest,
  and a queued memory task whose digest changed ends `staleInput`.
- `MemorySettings.structuredMemory.test.ts` compares the settings page's editable controls with the list it may
  expose, and the read guide's recipe says to expose a preset field only once something reads it.
- No `e2e` spec drives the Timeline. `StructuredMemoryPanel.test.ts` has about eighteen tests that select the
  Timeline; most open an event and use the edit, repair, or badge controls of what becomes Manage, and one ("reads
  story once per refresh, ...") switches between `views.titles` and `views.story`.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_.

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused command
  `pnpm --silent test:agent structuredMemory StructuredMemory memory/structured MemorySettings normalizeCollections memoryTaskHost`,
  then `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, and `pnpm check:docs`
  for a guide edit, and `pnpm check:tests` after adding or moving a test. Run `pnpm check` again after the last test
  edit. V4 (`rg` each changed export, wire field, and
  language key) and V6 (each new test shown failing once with its guarded line broken).
- **Strings.** New user-visible text goes in `src/lang/en.ts` under `structuredMemory`, with its Korean in
  `src/lang/ko.ts` in the same slice, in the terms the panel already uses (사건, 문서, 기억, 원문과 어긋남).
- **Plain text.** Record text (titles, summaries, key lines) is rendered as text, never as Markdown or HTML.
- **Persisted values.** No stored spelling changes. A new wire or preset field is optional, and absent means today's
  behavior.
- **No new write.** This plan adds no memory write: the Manage view's edits and repairs keep their routes, guards,
  and rereads as they are.
- **Guide.** Each slice names its guide and updates the sections that name a changed contract. `read.md` is at
  34,605 bytes of a 40,000-byte ceiling: describe the tab's view rules in the component's contract comment and keep
  the guide to what crosses files. Comments and test titles describe behavior, not this plan (STRUCTURE.md T5).
- **Tests.** Panel behavior in `src/lib/Others/StructuredMemory/StructuredMemoryPanel.test.ts`, routes in
  `server/src/tests/structuredMemoryRoutes.test.ts`, the tab client in `src/ts/process/structuredMemory.test.ts`,
  pure rules beside their module.
- **Manual checks.** Each slice lists the browser and device checks it cannot run; the slice report gives them to
  the owner as a checklist, and what is unrun when the plan closes moves to
  [manual checks](../backlog/manual-checks.md) under this plan's name.

## Order

Serial: 1 → 2 → 3 → 4. Files more than one slice edits: `TimelineTab.svelte`, `StructuredMemoryPanel.test.ts`,
`src/lang/en.ts`, and `src/lang/ko.ts` (slices 2 and 3 always, slice 4 the tab and the test always and the language
files only for a missing label); `shared/structuredMemory.ts` (slices 1, 2, 3);
`src/ts/process/structuredMemory.svelte.ts` and `src/ts/process/structuredMemory.test.ts` (slices 1, 2, 4);
`read.md` (slices 2, 3, 4). Slice 1 is first because slice 2 marks important events from its field. Slice 3 follows
slice 2 so that the preset field is exposed only once the reading view reads it. If the run stops early, slices 1
and 2 stand alone with a fixed group size.

## Slice 1. The story read carries each event's grade (_small_, `structured-memory/records.md`)

Files: `shared/structuredMemory.ts`, `server/src/routes/structuredMemory.ts`,
`src/ts/process/structuredMemory.svelte.ts`, `server/src/tests/structuredMemoryRoutes.test.ts`,
`src/ts/process/structuredMemory.test.ts`, `records.md`.

- `StructuredMemoryStoryEvent` gains `grade` from `MemoryEvent` (optional). The `/story` round projects the stored
  `grade` beside the four fields it projects today, as stored; an event without one has no key in the answer.
- The client's story row reader keeps `grade` only when it is an integer from 0 to
  `STRUCTURED_MEMORY_LIMITS.gradeMax`, and drops any other value, as it drops a malformed date. It keeps reading
  partial rows (a restored event can lack fields) as it does today.
- An older tab ignores the field and an older server omits it; neither is an error, and a row without it is an
  ungraded event.
- `records.md`: the read routes' `/story` line names the fifth field and says "Timeline's story read" instead of
  naming a view.
- Test: the route test's exact-field assertion becomes five fields for a graded fixture and four for an ungraded
  one; the client reader keeps a valid grade, drops a string, a fraction, and a value above the maximum, and still
  reads a round without the field. The two client tests that compare parsed rows with `toStrictEqual` keep passing
  for rows without a grade.
- Manual checks: none of its own. The route and reader tests cover the wire field, and slice 2 checks the star.

## Slice 2. The Timeline opens as a reading view, with Manage beside it (_hard_, `structured-memory/read.md`)

Files: `shared/structuredMemory.ts`, `shared/structuredMemory.test.ts`, `TimelineTab.svelte`,
`src/ts/process/structuredMemory.svelte.ts` and `src/ts/process/structuredMemory.test.ts` (comments and a test title
that name the story view or the Timeline row), `GreetingCitation.svelte` only if rendering the jump alone needs a
prop, `src/lang/en.ts`, `src/lang/ko.ts`, `StructuredMemoryPanel.test.ts`, `read.md`.

- **Groups, a pure rule.** `memoryEventGroups(events, size)` in `shared/structuredMemory.ts` takes events in story
  order (oldest first), each with an id and an optional `MemoryStoryDate`, and returns groups in the same order:
  - Consecutive events with the same date key form one group. The key is `formatStoryDate(date)`, so a date with a
    year and the same day without one are different groups (D8). An event without a date joins the group before it;
    events without a date at the very start form a group whose date is null.
  - The rule never sorts by date: a flashback forms its own group where it stands.
  - A group of more than `size` events is cut into `ceil(n / size)` parts of near-equal length, in order; each part
    carries its number and the count of parts.
  - A new constant, `STRUCTURED_MEMORY_LIMITS.eventsPerGroup` (10), is the size this slice passes.
- **Views.** `view` becomes `"read" | "manage"`, default `"read"`, held while the tab is mounted. The language key
  `timeline.views` becomes `{ read, manage }` ("Read" / "Manage", 읽기 / 관리), replacing `{ titles, story }` in both
  language files.
- **Manage** is today's Titles view with one change: rows are listed newest first, and rows no message or stored
  position places (`position: Infinity`) come last (D9). It keeps retracted events, every badge, the open-event
  details with the edit control, `MemoryEventFacts`, the sources with the full greeting citation and its repairs,
  the stale repairs, and `ROWS_AT_ONCE`. `memoryTimelineRows` itself does not change.
- **Read** reads the story as today's Story view does (once per `refresh`, with `storyRead`, `storyNumber`, and the
  invalidation after a text edit keyed to this view as they are keyed to Story today) and leaves out retracted
  events.
  - It lists groups newest first and the events inside a group oldest first. The newest group is open; the others
    are closed until pressed, and a pressed group stays open while the tab is mounted. Groups are shown 30 at a time
    behind "show more".
  - A group's heading shows its date (`formatStoryDate`), its part number when it was cut ("(2)"), the count of
    events, and the range of `turnsAgo` over its events that have one. A group without a date shows the count and
    the range alone.
  - An event's row shows its title and its summary, with a star before the title when its grade is
    `importantEventGrade` or above. No badge and no `turnsAgo` on the row.
  - Pressing an event opens it (one at a time, the record read as today) and shows the story time text, the key
    lines, the participants as links to Pages, the links that jump to the cited messages, a greeting citation as its
    jump alone, and one button, "Open in Manage", which switches the view and opens the same event there. No edit
    control, no repair, no greeting repair buttons, and no `MemoryEventFacts` in Read.
  - A story read that failed, or a row whose summary is missing, keeps the titles readable: with no dates every
    event falls into date-less groups cut by size, so the view still reads as ranges of turns.
- **The check notice.** Above the groups in Read, when one or more events read `stale` after reconciliation or carry
  a `rerecord` mark, one line says how many (each event once) and offers a button that switches to Manage and
  reveals the first of them. Nothing is shown when there is none. A changed greeting on an event that is neither
  stale nor marked is not counted; its label and repairs stay in Manage.
- **Revealing an event.** One rule serves a `focus` from another tab, "Open in Manage", and the notice's button.
  - It finds the event by id among all reconciled rows, not among the rows a view lists.
  - The view: "Open in Manage" and the notice's button select Manage first. A `focus` keeps the current view when
    that view lists the event and switches to Manage for a retracted event.
  - It makes the row visible: in Manage by raising the row limit past it, in Read by opening its group and raising
    the group limit past it.
  - A `focus` and "Open in Manage" then open the event as a press does (`openRow`: the record read and the expanded
    details); the notice's button only reveals the row.
  - The target stays pending, and is not marked handled, until its row is rendered and scrolled to: across the view
    switch, and while a story read is out, since the dates that arrive can move the event into another group.
  - When the coverage read has settled and has no row with that id, the tab reads coverage once more, since the
    target can be newer than the rows it holds. After an accepted, successful reread it reveals the event if the id
    is there, and otherwise shows one line saying the event is no longer recorded and drops the target. A failed or
    refused reread shows the coverage error and proves nothing about the event; a superseded or wrong-chat answer
    is ignored.
- **Selectors.** Each rendered row keeps `data-memory-event` and `data-memory-event-status`, with the event's toggle
  button as its direct child carrying `aria-expanded`; `data-memory-source`, `data-memory-participant`, and
  `data-memory-event-summary` stay on those elements wherever they render. Each fixture of the panel test that
  lands on the Timeline from Pages serves `/story` rows from its own events, the page-mentions test's local events
  included, so those tests run through the ordinary Read path with their assertions as they are.
- `read.md`: Pages, Timeline, and Threads and the Files entry for the tab name the two views, the shared grouping
  rule, and that Read is the story read; the component's contract comment owns the view rules.
- Test:
  - `memoryEventGroups`, in `shared/structuredMemory.test.ts`: a date change opens a group; an undated event joins
    the group before it; leading undated events form a date-less group; a flashback is its own group; a long group
    is cut into near-equal parts; a group at exactly `size` is not cut.
  - Panel: the tab opens in Read with the story read made once; groups are newest first and events oldest first
    inside; only the newest group is open; a graded event at or above the threshold shows the star; a retracted
    event is absent from Read and present in Manage; Manage lists newest first with unplaced rows last; the notice
    counts stale and marked events and its button lands on the first in Manage; a changed greeting shows its jump
    without repairs in Read and with them in Manage; a failed story read still lists titles in groups; an old story
    answer arriving after Read → an edit in Manage → Read is rejected.
  - Revealing: a focus opens the event (its toggle reads `aria-expanded="true"`) in the current view and switches
    to Manage for a retracted one; a focus on an event beyond the first 30 groups, and "Open in Manage" on one
    beyond the first 200 rows, raise the limit and scroll; a focus that arrives before the story read settles lands
    on the event in its final group; a focus on an id a successful coverage reread still lacks shows the one-line
    notice, and a failed reread shows the coverage error instead.
  - The existing Timeline tests that edit, repair, or read badges switch to Manage first; the titles/story test is
    rewritten for the two views.
- Manual checks: the reading view on a phone-width screen (group headings wrap, the star does not shift the title);
  a real chat with dated events groups by day and reads top to bottom as expected; "Open in Manage" lands on the
  same event.

## Slice 3. The group size is a memory preset option (_small_, `structured-memory/writer.md`, `read.md`)

Files: `shared/structuredMemory.ts`, `server/src/jobs/jobScope.ts`,
`src/lib/Setting/Pages/MemorySettings.svelte`, `TimelineTab.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`,
`server/src/tests/normalizeCollections.test.ts`, `server/src/tests/memoryTaskHost.test.ts`,
`src/lib/Setting/Pages/MemorySettings.structuredMemory.test.ts`,
`src/lib/Setting/Pages/MemorySettings.hypaV3Export.test.ts`, `StructuredMemoryPanel.test.ts`,
`src/ts/storage/tests/fixtures/boot/boot-snapshot.json`, `writer.md`, `read.md`.

- `StructuredMemorySettings.eventsPerGroup`: an integer from 3 to 30, default
  `STRUCTURED_MEMORY_LIMITS.eventsPerGroup` (10), normalized with `integerIn` like the other counts, so a missing or
  malformed value reads as 10.
- `structuredMemoryFingerprint` leaves the field out, beside the three highlight fields: it changes what a person
  sees, not what the writer records, so changing it must not end a queued task as `staleInput` (D10).
- The Memory settings page gains one count control for it (the `structuredCount` snippet), with a label and one line
  of help: a day with more events is shown in parts, and the same number is the target size of a chapter once
  chapters exist. Add it to the list `MemorySettings.structuredMemory.test.ts` allows.
- `TimelineTab.svelte` reads the chat's preset as `CoverageTab.svelte` does: it resolves `preset` with
  `chatHypaV3Preset(...)` and passes `normalizeStructuredMemorySettings(preset?.settings.structured).eventsPerGroup`
  to `memoryEventGroups`. A change of the preset regroups the view with no read.
- The fresh-boot fixture's preset entry gains `eventsPerGroup: 10`, and the normalizer suite's full `structured`
  default and custom expectations gain the field: the boot test compares preset entries whole and the suite compares
  the `structured` object whole.
- `writer.md`: the preset fields and the fingerprint's exceptions name the new display-only field. `read.md`: the
  panel components that resolve a chat's preset include the Timeline.
- Test: the normalizer keeps a valid value and falls back for a missing one, a string, 2, and 31, through preset
  creation and collection normalization; the fingerprint is equal across a change of the field; the settings control
  writes the field only in the selected preset; an exported and re-imported preset keeps a non-default value; the
  panel regroups when the chat's preset value changes.
- Manual checks: changing the value in Settings and reopening the panel regroups a long day into the expected parts.

## Slice 4. Text search in the Timeline (_hard_, `structured-memory/read.md`)

Files: `src/ts/process/structuredMemory.svelte.ts`, `PagesTab.svelte`, `TimelineTab.svelte`, `src/lang/en.ts` and
`src/lang/ko.ts` only if a label is missing, `StructuredMemoryPanel.test.ts`,
`src/ts/process/structuredMemory.test.ts`, `read.md`.

- Move the text search's request lifecycle out of `PagesTab.svelte` into one helper in `structuredMemory.svelte.ts`
  that each mounted tab instantiates with getters for its chat, its `refresh`, and its trimmed draft: the submitted
  query, the hits, the failure, the in-progress flag, the request number, the rejection of an answer when the chat,
  `refresh`, or the query moved, and the rerun of an active query on `refresh`. `PagesTab.svelte` keeps everything
  else as it is: its raw `query` and the title filter it drives, the bound it applies to the trimmed submission
  (not to typing), its IME state, its display gates, its form, and its rendering. Its behavior and tests do not
  change.
- The Timeline's Read view gains its own form at the top of the view, outside the branch that shows the empty
  state, so it is there in a chat that has pages and no events: a native input with `maxlength` of
  `MEMORY_FIND_QUERY_CHARS`, submitted with Enter or its button, never while typing and never during IME
  composition, and a clear control that restores the groups.
- While a search is showing, its hits replace the groups: event hits with title and excerpt, and page hits with
  title, heading, and excerpt. Pressing a page hit calls `open({ tab: "pages", id })`. Thread hits are not listed,
  as in Pages. The empty result, the failure, and the notice Pages shows when the collected result sets `more`
  ("Showing the first 200 matches") reuse Pages' strings.
- Pressing an event hit clears the search and reveals the event through slice 2's rule, as a `focus` does. Search
  and coverage are read independently, so a hit can be an event the coverage read shows retracted, which opens in
  Manage, or one coverage does not have, which takes the rule's last step (one more coverage read, then the
  one-line notice only when that read succeeded without the id).
- `read.md`: Pages, Timeline, and Threads says the text search is one helper with a form in both tabs.
- Test: the helper rejects an answer after the query, the chat, or `refresh` moved and reruns on `refresh`
  (`structuredMemory.test.ts`); in the panel, a Timeline search lists event and page hits, an event hit opens the
  event in its group with the search cleared, a hit whose event the coverage read shows retracted opens in Manage,
  a hit whose id coverage lacks shows the notice, a page hit opens Pages, clearing restores the groups, the form is present with no events, and the Pages search
  test still passes unchanged.
- Manual checks: Korean IME composition does not submit early; a search on a phone-width screen keeps the input and
  the button on one line.

## Decisions

The owner accepted D1 to D7 on 2026-11-18. D8 to D10 are this plan's own, found against the code.

- D1. The Timeline's views are Read and Manage; Titles and Story go. Scanning titles is Manage's job, and Read has
  no "titles only" mode.
- D2. Read lists groups newest first and the events inside a group in story order.
- D3. A group is a run of events on one story date; a day with more events than the group size is shown in parts.
  The owner reports that their chats track the story's date in every message and expects most events to be dated;
  the rule also handles events with no date.
- D4. The group size is one option of the memory preset, default 10, so it follows the preset a chat selects. The
  same number is the target size of a chapter in the chapter plan.
- D5. An important event (grade 6 or above, the threshold Pages already uses) is starred in Read.
- D6. Work order: this view and its ordering, then search in the Timeline, then chapter synopses (their own plan).
  A search of the original messages is outside this work.
- D7. The checking tools stay complete in Manage; Read shows one notice when something needs checking.
- D8. Two dates are the same day when `formatStoryDate` gives the same text. A date recorded once with a year and
  once without groups apart; the plan accepts that rather than guess a year.
- D9. Manage lists newest first, which answers "the oldest event is on the first line" there too; rows nothing
  places go last.
- D10. `eventsPerGroup` stays out of the memory settings fingerprint, in this plan and in the chapter plan: a
  chapter keeps the events it was made from, so a later change of the size regroups only what has no chapter yet.

## Not In This Plan

- Chapter synopses, their record, their model call, and their button ([the chapter plan](timeline-chapters.md)).
- Searching the original messages from the memory panel, proposed as its own session on 2026-11-18.
- Any change to the prompt, the writer, stored records, or the events a send selects.
- A filter by participant or by grade, and sorting options.
- An `e2e` spec for the panel: none exists, and the panel test mounts the real components.
- Changes to the Pages tab beyond moving its search request into the shared helper.

## Open Questions

None open. The owner answered D1 to D7 on 2026-11-18.
