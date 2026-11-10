# Memory Panel Readability Plan

Status: drafted 2026-11-11 at `09ce72896` from the owner's request; the owner accepted the default of D1 to D6 the same
day (Decisions); audited the same day by a read-only GPT-6-Astra session in `full` mode, at the owner's request in
place of plan-runner's own audit ([report](../reports/audits/plan-runner/memory-panel-readability-2026-11-11.md): no
P1, and every P2 and P3 is fixed in this text). The report and this line share the plan's last commit, so a plan-runner
run skips its Plan audit unless the plan changes again. Landed: 1 (`3e44dd10f`), 2 (`1ce6f125e`), 3 (`306268128`).

Sources: the owner's question (2026-11-11: BardWiki is a wiki, so a person reads it as long-term memory too; where is
Structured Memory unclear to its user?); the panel's components under `src/lib/Others/StructuredMemory/` and its
strings in `src/lang/en.ts` and `src/lang/ko.ts`, read at `09ce72896`; the
[structured memory guides](../structure/structured-memory/README.md); the
[RisuBard survey](../reports/surveys/risubard-survey.md) §2.1 and RisuBard 0.9.96's `docs/ko/memory-wiki.md` for what
BardWiki shows a person. The session re-read in source every mechanism a slice rests on: `TABS` and the first tab,
`PagesTab.svelte`'s detail, `TimelineTab.svelte`'s details, `LogTab.svelte`'s `extraction` snippet, the `/coverage`
and `/package` rounds with `roundOf` and `answerRound`, the edits route, `parseMemoryEdit` and `applyPageEdit`,
`parseMemoryPageTool`, `applyPageTool` and `splitPages`, `seededPage`, `rebuildChanges` and `swappedEvent`,
`retireRerecorded`, `flagUnsupportedSections`, and the field checks of `restore.ts`. Line numbers are from that read;
the identifiers are the anchors. Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

The memory panel is built to check that memory works. It should also be where a person reads what the chat remembers:

- **Readable.** A page opens as a text to read, the story so far can be read in order, and an event shows what it
  changed.
- **Findable.** A person can find a page by title, find text in pages and events, and see which events name a page.
- **Correctable.** A person can rename a page, edit its aliases, correct an event's title and summary, and write a
  note page of their own, and none of that is lost to the next re-record or rebuild.
- **Plain words.** The Korean strings name things by what they are.

Not goals: file-native Markdown storage or editing in an external editor (the Markdown package covers reading);
rendering record text as Markdown or HTML (all record text stays plain, as the tabs' contracts say); a
natural-language admin terminal; any change to what a send selects or to the writer's prompts.

## Current State

- `StructuredMemoryPanel.svelte` lists `TABS` as coverage, preview, pages, unsupported, timeline, threads, log,
  settings, and opens on `TABS[0]`, the coverage tab, unless `takeMemoryPanelTarget` names a tab.
- `PagesTab.svelte` shows a page as controls first (context mode, grade, page tools), then one bordered block per
  section with a lock checkbox, an Edit button, provenance and source links, then the history. It has no search input,
  never renders `MemoryPage.links`, and its contract says "Titles, aliases, types, and links have no editor."
- `TimelineTab.svelte` lists event titles; one event opens at a time, and opening reads its record
  (`readStructuredMemoryRecord`). The details show the summary, story time, participants, key lines, and sources. State
  changes, knowledge, relationship shifts, and thread changes are rendered only by `LogTab.svelte`'s `extraction`
  snippet, from `memoryRunView`; `memoryEventView` already gives Timeline the same view of a stored event.
- No route gives the tab event summaries by event id in a light, paged form: `/package` sends whole pages and events,
  and `/projection` sends HypaV3-shaped summaries of active events for plugins. `/coverage` reads each event's record in
  a budgeted round (`answerRound`, `roundOf`, `packageRoundBytes`) and sends its title, status, and sources.
- `StructuredMemoryEdit` is a closed union: a section's body, lock, keep and release; a page's context mode and grade;
  a thread's state; an event's repair. `editBody` refuses a heading the page lacks (`sectionGone`), so a person cannot
  add a section. `StructuredMemoryPageTool` is trash, untrash, purge, merge, split.
- `MemoryEvent` extends `MemoryTrustFlags`, so an event can hold `userCorrected`; nothing sets it on an event today.
  `retireRerecorded` and `swappedEvent` already carry the mark, without any text.
- `seededPage` keeps a page through a rebuild when a section is marked (`sectionMarked`), the grade is a person's, the
  context mode is not `auto`, the page is `reshaped`, or a retained thread names it. A live page that is not in the
  staged set is removed at the swap.
- `flagUnsupportedSections` ignores a section with an empty `provenance`, so a person's own section is never flagged.
- `restore.ts` keeps fields the record types do not name ("so a newer file loses nothing") and checks every named
  field through `FieldChecks<T>`. `renderMemoryPage` writes every page field except `history` into the package's
  frontmatter, and `renderMemoryTimeline` every event field.
- `MEMORY_HISTORY_CHANGE_KINDS` is a closed list that an older build's `restore.ts` checks, so a new kind makes that
  build refuse a chat file whole ([page tools](../structure/structured-memory/pages.md) Limitations).
- Only `src/lang/en.ts` and `src/lang/ko.ts` hold `structuredMemory` strings. In `ko.ts` the block (2439 to 3016)
  has 50 lines that say 메모리, 56 페이지, 31 이벤트, 12 스레드, and 10 기억 (57, 62, 32, 13, and 11 occurrences); `stale`
  reads "오래됨" although its reasons are an
  edited, deleted, inserted, or moved source.
- No `e2e` spec drives the memory panel. `StructuredMemoryPanel.test.ts` mounts the real panel with `authFetch`
  scripted.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_; routine slices name no Codex challenger.

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused command
  `pnpm --silent test:agent structuredMemory StructuredMemory memory/structured memoryStore restoreStage`, then
  `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, and `pnpm check:docs` for a
  guide edit. Run `pnpm check` again after the last test edit: Vitest does not type-check. V4 (`rg` each changed
  export and wire field) and V6 (each new test shown failing once with its guarded line broken).
- **Strings.** New user-visible text goes in `src/lang/en.ts` under `structuredMemory`, with its Korean in
  `src/lang/ko.ts` in the same slice, written in slice 1's terms.
- **Plain text.** Record text (titles, bodies, summaries, quotes) is rendered as text, never as Markdown or HTML.
- **Persisted values.** No persisted spelling changes: record fields, `stale`, `MEMORY_HISTORY_CHANGE_KINDS`, route
  paths, and language keys stay. A new field is optional and absent means today's behavior.
- **Writes.** A panel write names the revision of its read and goes through the edits route or the page tools route,
  whose checks and write share one synchronous step after the fence. The tab never sends a record.
- **Guide.** Each slice names its guide; that guide's `Invariants` apply, and the slice updates the sections that name
  a changed contract. A guide stays under the 40,000-byte ceiling. Comments and test titles describe behavior, not this
  plan (STRUCTURE.md T5).
- **Tests.** Panel behavior is tested in `src/lib/Others/StructuredMemory/StructuredMemoryPanel.test.ts`, routes in
  `server/src/tests/structuredMemoryRoutes.test.ts`, the tab client in `src/ts/process/structuredMemory.test.ts`, and
  pure rules beside their module.
- **Manual checks.** Each slice lists the browser and device checks it cannot run. The slice report gives them to the
  owner as a checklist; what is still unrun when the plan closes moves to
  [manual checks](../backlog/manual-checks.md) under this plan's name.

## Order

Serial: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Every slice but 3 edits `src/lang/en.ts` and `src/lang/ko.ts` (slice 3 only if a
label is missing), and slices 2 to 8 edit `StructuredMemoryPanel.test.ts`; slices 2, 5, 6 and 8 edit `PagesTab.svelte`;
slices 3, 4 and 7 edit `TimelineTab.svelte`; slices 4 to 8 edit `shared/structuredMemory.ts`,
`server/src/routes/structuredMemory.ts` (slice 6 its contract comment alone), and, but for slice 7,
`src/ts/process/structuredMemory.svelte.ts`. The slices run serially.

Slice 1 is first so later strings are written once. Slice 8 needs slice 6's `namedByUser`. If the run stops early,
slices 1 to 3 stand alone as the reading improvements, and each later slice stands on the ones before it.

## Slice 1. Korean terms name what things are (_small_, `settings-i18n.md`)

Files: `src/lang/ko.ts`, `src/lang/en.ts`, and the tests that match a changed English string.

- Korean terms, in every string that names this algorithm's records, panel, writer, or states (D1):

  | Now    | After         | Meaning                                              |
  | ------ | ------------- | ---------------------------------------------------- |
  | 이벤트 | 사건          | `MemoryEvent`                                        |
  | 페이지 | 문서          | `MemoryPage`                                         |
  | 스레드 | 미결 사항     | `MemoryThread`: a promise, foreshadowing, a question |
  | 메모리 | 기억          | this algorithm's memory, records, panel, and writer  |
  | 오래됨 | 원문과 어긋남 | `stale`: a cited message changed                     |

- Scope: the `structuredMemory` object of `ko.ts`, and the structured-memory-only strings outside it: the chat status
  health lines that name memory events, sections, and pages (`ko.ts` ~753 to 761), the rebuild lock text (~1192), the
  record and rebuild conflict toasts (~1211, ~1213), the receipt block titled "메모리 기록" (~1331 to 1337), and, under
  `memoryTasks`, `rebuilt` (~2391) and the reasons `writerPaused`, `revisionConflict`, `awaitingAdoption`, and
  `memoryRebuilding` (~2428), which the panel's task line (`memoryTaskStatusLine`) and `MemoryReceiptLine.svelte` show.
  The slice reads each string's consumers before changing it and lists every key it changed in its report.
- What keeps 메모리: the names of surfaces every algorithm shares, wherever a string cites them: the settings page and
  its opener ("메모리", "메모리 설정", "메모리 설정 열기"), "메모리 프리셋", the "메모리" auxiliary model, the memory toggle
  ("메모리 켜짐", "메모리가 꺼져 있어"), and the context meter's legend. 페이지 stays where it means the browser page
  ("페이지를 새로고침해 주세요").
- The feature's name stays "구조화 기억".
- English: only `stale` changes, to "sources changed" (the manifest exclusion, ~`en.ts` 2582), "Sources changed" (the
  coverage state, ~2751), and `Sources changed: ${reason}` (Timeline, ~2941). "Threads", "Events", and "Pages" stay.
- No key, identifier, or stored code changes, so no component changes.
- Check, in place of a test: within the scope, `rg` for 이벤트, 페이지, 스레드, 메모리, and 오래됨 finds only the
  exceptions above; the report lists them.

## Slice 2. A page opens as a text to read (_hard_, `structured-memory/read.md`)

Files: `src/lib/Others/StructuredMemory/StructuredMemoryPanel.svelte`, `src/lib/Others/StructuredMemory/PagesTab.svelte`,
`src/lang/en.ts`, `src/lang/ko.ts`, `StructuredMemoryPanel.test.ts`, `docs/structure/structured-memory/read.md`.

- **First tab** (D2). `TABS` becomes pages, timeline, threads, unsupported, coverage, preview, log, settings, so a
  panel with no pending target opens on Pages. A `MemoryPanelTarget` still chooses its tab, and the `unsupported` tab's
  visibility rule is unchanged.
- **Two views of a page.** The detail gets a `SegmentedControl` with `read` and `manage`, tab state that starts at
  `read` and lasts while the tab is mounted.
  - `read`: the title, one line with the type and aliases, the links row, then each section with a non-blank body as
    its heading and its body, with no border, checkbox, button, provenance, or source row. A section's `disputed`,
    `unsupported`, `userCorrected`, and `locked` show as text badges after the heading. Nothing else.
  - `manage`: the detail as it is today (context mode, grade, page tools, section blocks, history).
  - With `only="unsupported"` there is no control and the view is `manage`. A `focus` that carries `historyId` sets
    `manage` before `openAskedEntry` runs. A page in the trash shows `manage`.
- **Links row**, in both views: `page.links` as `MemoryLinkButton`s labelled with the linked page's title from
  `contents.pages`; pressing one selects that page. An id that names no live page is a disabled button showing the id.
  No row when the list is empty.
- **Title filter.** A `TextInput` above the tree, not under `only="unsupported"`: the listed pages are narrowed to
  those whose `title` contains the trimmed text, compared with `toLowerCase()`, before `memoryPageTree` groups them, so
  an empty group has no header; `shownRows` resets when the text changes; a text that matches nothing shows one line
  saying so. Aliases and bodies are not searched here (slice 5).
- `read.md`: The memory panel (tab order, first tab) and Pages, Timeline, and Threads (the two views, the filter).
- Test, in `StructuredMemoryPanel.test.ts`:
  - the panel opens on Pages when no target is pending, and on Timeline when a target names it; the existing cases
    that assume the coverage tab is first, or press a tab by position, are updated to name their tab;
  - `read` shows a section's body and no `[data-memory-section-edit]`; switching to `manage` shows it;
  - a target with `historyId` shows `manage` with that entry's diff open;
  - the filter leaves only matching titles and drops an emptied group's header;
  - a links row button selects the linked page, and an unknown id is disabled.
- Manual checks: the read view at phone width (about 360px) and in each theme; a long page scrolls inside the panel.

## Slice 3. Timeline shows what an event changed (_small_, `structured-memory/read.md`)

Files: new `src/lib/Others/StructuredMemory/MemoryEventFacts.svelte`, `LogTab.svelte`, `TimelineTab.svelte`,
`src/lang/en.ts` and `src/lang/ko.ts` only if a label is missing, `StructuredMemoryPanel.test.ts`, `read.md`.

- Move the state changes, knowledge, relationship shifts, and thread changes of `LogTab.svelte`'s `extraction`
  snippet into `MemoryEventFacts.svelte`. Props: the `MemoryRunEventView`, and optional `pageTitles` and
  `threadTitles` maps. An id with a title in its map shows the title; without a map, or without an entry, it shows the
  id, which is what the Log shows today.
- `LogTab.svelte` renders the component with no maps, so its output is unchanged.
- `TimelineTab.svelte`'s details render it under the key lines. `openEvent` is already the `MemoryRunEventView` that
  `readOpen` made with `memoryEventView`, so it is passed as it is, never converted again (a second conversion finds
  no `openThreads` and empties the thread lists), with `pageTitles` and with thread titles taken from the same
  contents read that already supplies `pageTitles`. Labels reuse `language.structuredMemory.log`.
- `read.md`: Pages, Timeline, and Threads; Files gains the component.
- Test, in `StructuredMemoryPanel.test.ts`: an opened event shows a state change with the page's title, a knowledge
  item with its stance, and a relationship shift; the Log's existing extraction cases still pass unchanged.

## Slice 4. The story so far reads in order (_hard_, `structured-memory/records.md`, `read.md`)

Files: `shared/structuredMemory.ts`, `server/src/routes/structuredMemory.ts`, `src/ts/process/structuredMemory.svelte.ts`,
`TimelineTab.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`, `server/src/tests/structuredMemoryRoutes.test.ts`,
`src/ts/process/structuredMemory.test.ts`, `StructuredMemoryPanel.test.ts`, `records.md`, `read.md`.

- **Route.** `GET STRUCTURED_MEMORY_PATH/:characterId/:chatId/story?cursor=N`, through `answerRound` like `/coverage`:
  it lists `store.memory.readKinds(characterId, chatId, ["events"])`'s events by position, takes
  `roundOf(listed, cursor, packageRoundBytes)`, and answers `StructuredMemoryStoryRound`,
  `{ revision, events: StructuredMemoryStoryEvent[], next }`, where an event is `{ id, summary, storyTime,
participants }` read from its record. Title, status, and order are not repeated: the tab joins by id with the
  coverage facts it holds. The route header comment gains the entry.
- **Bound.** A round charges stored bytes like `/coverage`, with `roundOf`'s soft first-record rule, and answers
  through `compressedJson`: what it sends of the records is bounded by the stored bytes it charged, plus the answer's
  envelope. A writer's event sends at most `eventSummaryChars` of summary, a `labelChars` story time, and
  `pageRefsPerItem` ids; a restored record may pass those limits (`restore.ts` refuses nothing by them) and is sent as
  stored, not cut.
- **Client.** `readStructuredMemoryStory(ref)` collects rounds at one revision and starts over when a round answers
  another revision, as the package builder's rounds do.
- **Tab** (D3). Timeline gets a `SegmentedControl`, `titles` (today's list) and `story`. In `story`:
  - rows are `memoryTimelineRows`' rows oldest first, without retracted events;
  - each row shows its title, the story time when it has one, its badges, and its summary as plain text, with no
    press; pressing the row still opens the details and repairs;
  - summaries are read when `story` is first chosen and again whenever `refresh` moves while it is chosen; a row
    whose summary has not arrived shows its title alone; a failed read shows the tab's failure line and keeps titles;
  - `ROWS_AT_ONCE` and "show more" apply as in `titles`.
- `records.md`: The read routes and Files; `read.md`: Pages, Timeline, and Threads.
- Test:
  - `structuredMemoryRoutes.test.ts`: two rounds under a lowered `memoryPackageRoundBytes` join to every event's
    summary; a cursor past the end; 404 `chatGone`; an event's answer holds only the four fields.
  - `structuredMemory.test.ts`: the collector restarts when the second round names another revision.
  - `StructuredMemoryPanel.test.ts`: `story` shows summaries in message order, leaves a retracted event out, and reads
    `/story` once per `refresh`.
- Manual checks: a chat with several hundred events switches to `story` without a visible stall; phone width.

## Slice 5. Find text, and the events that name a page (_hard_, `structured-memory/records.md`, `read.md`)

Files: `shared/structuredMemory.ts`, `server/src/routes/structuredMemory.ts`, `src/ts/process/structuredMemory.svelte.ts`,
`PagesTab.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`, `structuredMemoryRoutes.test.ts`, `structuredMemory.test.ts`,
`StructuredMemoryPanel.test.ts`, `records.md`, `read.md`.

- **Route.** `GET STRUCTURED_MEMORY_PATH/:characterId/:chatId/find?cursor=N` with exactly one of `q` and `page`; both
  or neither is 400. Through `answerRound`: it lists live pages then events, as `/package` does, takes
  `roundOf(listed, cursor, packageRoundBytes)`, reads each row's record, and answers `StructuredMemoryFindRound`,
  `{ revision, hits: StructuredMemoryFindHit[], next }`. Retracted events are never a hit, and the trash is not
  listed.
  - `q`: trimmed, 1 to `MEMORY_FIND_QUERY_CHARS` (100) characters, else 400. A plain substring compared with
    `toLowerCase()`, no pattern syntax. A page gives one hit per matching place: its title or an alias
    (`heading: null`), and each section whose body matches (`heading` set). An event gives one hit when its title,
    summary, or a key line matches. A hit is `{ kind: "page", id, title, heading, excerpt }` or
    `{ kind: "event", id, title, sourceIndex, excerpt }`; `excerpt` is at most `MEMORY_FIND_EXCERPT_CHARS` (160)
    characters around the first match.
  - `page`: a page id. Events only: one hit, with an empty `excerpt`, for each event whose `participants`, a
    `stateChanges` or `knowledge` item's `pageId`, a knowledge item's `knowers`, or a `relationshipShifts` item's `from`
    or `to` holds the id. `sourceIndex` is `firstSourceIndex(sources)`.
- **Client.** `findStructuredMemory(ref, query)` collects rounds at one revision, restarting like slice 4's reader,
  and stops with `more: true` once it holds `MEMORY_FIND_HITS_MAX` (200) hits.
- **Tab.**
  - The filter input of slice 2 gains a "search text" action (the button, or Enter). It runs `q` over the input's
    text and shows the hits in place of the tree: a page hit as its title, its heading when it has one, and the
    excerpt; an event hit as its title and excerpt. Pressing a page hit selects the page; pressing an event hit calls
    `open({ tab: "timeline", id })`. Clearing the input brings the tree back. `more` shows one line saying the list
    was cut at 200.
  - The detail, in both views, gets a closed "events naming this page" row. Opening it runs `page` once per page
    selection and `refresh`, and lists the hits by `sourceIndex`, nulls last, each a `MemoryLinkButton` that opens the
    event in Timeline. The scene page has the row too.
- `records.md`: The read routes and Files; `read.md`: Pages, Timeline, and Threads.
- Test:
  - `structuredMemoryRoutes.test.ts`: `q` finds a title, an alias, a section body, an event summary, and a key line,
    whatever the case; a trashed page and a retracted event give no hit; `page` finds an event by each of the five
    fields; `q` with `page`, neither, a blank `q`, and a `q` over the cap are 400; rounds join under a lowered budget.
  - `structuredMemory.test.ts`: the collector stops at the hit cap with `more`.
  - `StructuredMemoryPanel.test.ts`: a search lists hits, a page hit selects, an event hit opens Timeline on it,
    clearing restores the tree; the events row lists by `sourceIndex`.
- Manual checks: Enter in the input on a phone keyboard starts the search; a Korean query finds Korean text.

## Slice 6. A person renames a page and edits its aliases (_hard_, `structured-memory/pages.md`)

Files: `shared/structuredMemory.ts`, `server/src/prompt/memory/structured/pages.ts`,
`server/src/prompt/memory/structured/restore.ts`, `server/src/prompt/memory/structured/rebuild.ts`,
`server/src/routes/structuredMemory.ts` and `src/ts/process/structuredMemory.svelte.ts` (the contract comments that
list the tools; their dispatch is generic), `PagesTab.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`,
`structured/pages.test.ts`, `structured/rebuild.test.ts`,
`structured/restore.test.ts`, `structuredMemoryRoutes.test.ts`, `structuredMemory.test.ts`,
`StructuredMemoryPanel.test.ts`, `pages.md`, `rebuild.md`, `records.md`.

- Two page tools, because the page tools route already reads every live page for a name check (`PageToolRecords`),
  which the edits route does not:
  - `{ kind: "rename", pageId, title }`. `parseMemoryPageTool` takes a trimmed, non-blank title of at most
    `labelChars`, as for `split`. `livePage` refuses the scene and a trashed page. No other live page of the type may
    go by `nameKey(title)` (`pageNames`), the rule `splitPages` applies; the page's own alias may, and that alias
    leaves the list, since it is now the title. The old title joins the aliases (D6) unless its `nameKey` equals the
    new title's or an alias already has it. A list that would pass `aliasesPerPage` refuses the rename `invalid`,
    naming the cap: nothing is cut. A title equal to the stored one changes nothing.
  - `{ kind: "aliases", pageId, aliases }`: the page's whole list as the person wants it. Each is trimmed, non-blank,
    at most `labelChars`, distinct by `nameKey`, not the title's key, and not a name another live page of the type goes
    by; at most `aliasesPerPage`; anything else is `invalid`. A list equal to the stored one changes nothing.
- Both set `MemoryPage.namedByUser?: true`, a new optional field. Neither writes a history entry: the kinds are a
  closed list an older build checks.
- `seededPage`: `chosen` also holds when `page.namedByUser === true`, so a rebuild keeps the page's id, title, and
  aliases, and a language change does not retitle it. A fresh rebuild forgets it, like every mark.
- `restore.ts`: the page's `FieldChecks` gain `namedByUser`, optional and `true` only, like `reshaped`. The package's
  frontmatter already carries every page field.
- No other reader changes: receipts keep the title of their time, the `memory_pages.title` column follows the record,
  and the writer's cast, retrieval, and the card read the stored title. `sectionVectorText` holds the title, so a
  renamed page's sections are embedded again on later sends.
- **Tab.** In `manage`, the title has a Rename control (a `TextInput` with Save and Cancel) and the aliases an editor
  (each alias with a remove button, and an input that adds one); both go through `runTool`, off under `controlsOff`,
  absent on the scene page and in the trash. A refusal shows through the tool's existing failure path.
- `pages.md`: The page tools route, Invariants, Limitations; `rebuild.md`: What a rebuild keeps; `records.md`: Files.
- Test:
  - `pages.test.ts`: a rename moves the old title to the aliases and sets the mark; a title another live page of the
    type goes by is refused, and one a trashed page or a page of another type goes by is not; renaming to the page's
    own alias removes that alias; a full alias list refuses; the scene refuses; `aliases` refuses a duplicate key, the
    title, another page's name, and a list over the cap.
  - `rebuild.test.ts`: a page with only `namedByUser` is seeded with its title and aliases and survives the swap; a
    fresh rebuild drops it. The staged set holds an event, since a swap with none answers null.
  - `restore.test.ts`: `namedByUser: true` passes and `false` or a string is refused.
  - `structuredMemoryRoutes.test.ts`: both tools on a real app, the revision check, and the fence.
  - `structuredMemory.test.ts`: a renamed page round-trips through the package with its mark.
  - `StructuredMemoryPanel.test.ts`: the controls send the tools and show the answered page; they are absent on the
    scene.
- Manual checks: the alias editor at phone width.

## Slice 7. A person corrects an event's title and summary (_hard_, `structured-memory/lifecycle.md`, `records.md`)

Files: `shared/structuredMemory.ts`, `server/src/prompt/memory/structured/edits.ts`,
`server/src/routes/structuredMemory.ts`, `server/src/prompt/memory/structured/reconcile.ts`,
`server/src/prompt/memory/structured/rebuild.ts`, `TimelineTab.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`,
`structured/edits.test.ts`, `structured/reconcile.test.ts`, `structured/rebuild.test.ts`,
`structuredMemoryRoutes.test.ts`, `StructuredMemoryPanel.test.ts`, `records.md`, `lifecycle.md`, `rebuild.md`,
`read.md`.

- Two edits, new members of `StructuredMemoryEdit` with their own `kind`, so the `event` kind stays the repairs:
  - `{ kind: "eventText", eventId, title, summary }`. `parseMemoryEdit` takes a trimmed, non-blank title of at most
    `eventTitleChars` and a non-blank summary of at most `eventSummaryChars`; nothing is cut. A new pure
    `applyEventText` in `edits.ts` writes `title`, `summary`, and `userCorrected: true` and nothing else: sources,
    status, `keptState`, `rerecord`, grades, and every other field stay. A retracted event is refused `invalid`; an
    edit equal to the stored text answers null.
  - `{ kind: "eventRelease", eventId }`: removes `userCorrected` and nothing else; null when it is not set.
- **Route.** `editedRecordId` names `eventId` for both. The edits route gives them their own branch: it reads the
  stored event, applies the pure edit, and writes `{ events: [edited] }` at the request's revision. It reads no chat
  and does not call `withRetractedEvidence`. A no-op still passes the revision check with an empty change set.
- **Re-record** (D4). `retireRerecorded`: when the old event holds `userCorrected`, the replacement takes its `title`
  and `summary`, added to what the retirement already carries (the trust flags, the old event's thread closes and
  ended transitions, and the thread provenance), which stays as it is. The remaining fields are the new recording's.
- **Rebuild** (D4, D7). `swappedEvent`: when exactly one standing overlapping live event, counted by event id since
  the overlap list repeats an event once per shared message, holds `userCorrected` and cites the same set of message
  ids as the staged event, the staged event takes that event's `title` and `summary`. In every other case only the
  mark crosses, as today. A corrected event the swap does not replace is carried with its text, as every carried event
  is. A fresh rebuild carries neither, and a backfill replaces nothing.
- No other reader changes. `projectHypaV3Data` reads the summary when it projects, and a plugin read refreshes on the
  memory revision the write moved. `eventVectorTexts` reads the stored summary and key lines, not the title, so an event whose summary changed is
  embedded again on a later send. `renderMemoryTimeline` already carries every field, and a copy keeps an event's marks.
- **Tab.** The opened details get an Edit control: a `TextInput` for the title and a `TextAreaInput` for the summary,
  each with its count against the limit, Save and Cancel, one edit at a time, off while read-only. It sends through
  `editStructuredMemory` at the coverage revision. A repair's reread is not enough here: `read()` rereads coverage,
  which holds neither the summary nor the mark, and a memory write publishes nothing. So when an `eventText` or
  `eventRelease` settles, accepted or refused, the tab rereads coverage and the opened event's record, and reads
  `/story` again when `story` is chosen, under the tab's existing chat and read-number guards. `MemoryRunEventView`
  has no `userCorrected`, so the tab keeps the mark from the record it read beside the view. An event with the mark
  shows a badge that is a button: after `alertConfirm` it sends `eventRelease`. A retracted event has no Edit control.
- `records.md`: The edit route, Files; `lifecycle.md`: Reconciliation and repairs, Limitations (the rebuild case
  that keeps only the mark); `rebuild.md`: What a rebuild keeps; `read.md`: Panel edits.
- Test:
  - `edits.test.ts`: parse refuses a blank title, a blank summary, and either over its limit; apply sets the three
    fields and leaves `sources`, `status`, and `keptState`; a retracted event refuses; an equal edit and a release of an
    unmarked event answer null; release keeps the text.
  - `reconcile.test.ts`: a re-record over a `userCorrected` event commits the old title and summary with the new
    recording's key lines.
  - `rebuild.test.ts`: a staged event over the same messages as one corrected event takes its text; one over a
    superset takes the mark and keeps the writer's text; a fresh rebuild takes neither.
  - `structuredMemoryRoutes.test.ts`: both edits on a real app; a stale revision and the fence refuse; the write
    reads no chat (a poisoned chat row does not fail it).
  - `StructuredMemoryPanel.test.ts`: Edit sends the edit and shows the new title; the badge releases after the
    confirmation; a retracted event has no control.
- Manual checks: the editor at phone width with a Korean IME.

## Slice 8. A person writes a note page and adds sections (_hard_, `structured-memory/pages.md`, `records.md`)

Files: `shared/structuredMemory.ts`, `server/src/prompt/memory/structured/pages.ts`,
`server/src/prompt/memory/structured/edits.ts`, `server/src/routes/structuredMemory.ts`,
`src/ts/process/structuredMemory.svelte.ts` (the tool contract comment), `PagesTab.svelte`, `src/lang/en.ts`,
`src/lang/ko.ts`, `structured/pages.test.ts`, `structured/edits.test.ts`,
`structured/rebuild.test.ts`, `structuredMemoryRoutes.test.ts`, `StructuredMemoryPanel.test.ts`, `pages.md`,
`records.md`, `read.md`.

- **A new note** (D5). Page tool `{ kind: "create", title, heading, body }`. `parseMemoryPageTool` takes a title as for
  `rename`, a trimmed, non-blank heading of at most `labelChars`, and a body with text of at most `sectionBodyChars`.
  `parseMemoryPageTool` and `applyPageTool` branch on `create` before their `pageId` checks, and `pageToolIds`
  answers no id for it. The page is a `note`: `newPage` with a fresh id, `contextMode: "auto"`,
  `namedByUser: true`, one section (`provenance` and `sources` empty, `locked: false`, `userCorrected: true`,
  `updatedAt` the stamp's time), and one `create` history entry with `heading: null`, `before: null`, no `eventId`,
  not highlighted. No live `note` page may go by the title (`pageNames`). The answer's `data` is the new page.
- **An added section.** Edit `{ kind: "sectionAdd", pageId, heading, body }`, parsed like `section` with the heading
  trimmed, non-blank, and at most `labelChars`. `applyPageEdit` refuses `invalid` on a `scene` or `character` page
  (the scene is code's and a character page's headings are the fixed slots), when the page already has the heading,
  and when the page holds `sectionsPerPage` sections. It appends the section with the same fields as a new note's and
  an `edit` history entry with `before: null` and no `eventId`. The route's trash refusal applies as for every page
  edit.
- What follows from the existing rules, with no code: the writer lists the page in its cast and may patch a section
  that is not locked, as it may any `userCorrected` section; `flagUnsupportedSections` never flags an empty
  `provenance`; a rebuild seeds the page through `sectionMarked` and `namedByUser`; a history entry without an
  `eventId` is not revertable (`memoryPageHistoryView`).
- **Tab.** A "new note" button over the tree, not under `only="unsupported"`, opens a form (title, heading, body with
  its count). `runTool` and `sendChange` need a held page copy, so the form sends through
  `structuredMemoryPageTool` at the contents' revision; the answered page is selected in `manage`. In `manage`, a page that is not the scene, a character, or
  in the trash gets an "add section" form (heading, body). Both are off under `controlsOff`.
- `pages.md`: The page tools route, Invariants, Limitations (a person can add a section and cannot delete one);
  `records.md`: The edit route; `read.md`: Panel edits.
- Test:
  - `pages.test.ts`: `create` makes a note with the marked section and the `create` entry; a title a live note goes by
    is refused, and one a character goes by is not; a blank heading or body does not parse.
  - `edits.test.ts`: `sectionAdd` appends with `userCorrected` and an `edit` entry whose `before` is null; a
    character page, the scene, an existing heading, and a full page refuse.
  - `rebuild.test.ts`: a created note survives a rebuild's swap with its section, and a fresh rebuild removes it; the
    staged set holds an event. The page's whole-page `create` entry need not survive: `seededPage` keeps the history of
    marked headings.
  - `structuredMemoryRoutes.test.ts`: `create` and `sectionAdd` on a real app, the revision check, the fence, and a
    retraction afterwards leaves the note's section unflagged.
  - `StructuredMemoryPanel.test.ts`: the form sends `create` and selects the new page; "add section" is absent on a
    character page.
- Manual checks: both forms at phone width; a send after creating a note names it in the manifest when the chat
  mentions its title.

## Decisions

The owner accepted the default of D1 to D6 on 2026-11-11; the slices are written for them. D7 and D8 are this plan's
own, found against the code.

- D1. Terms. 이벤트 → 사건, 페이지 → 문서, 스레드 → 미결 사항, 오래됨 → 원문과 어긋남, and 메모리 → 기억 for this algorithm's
  own things. The names of surfaces every memory algorithm shares keep 메모리, so the panel never cites a settings page
  by a name that page does not carry; renaming those surfaces is not in this plan.
- D2. The panel opens on Pages; Coverage, Preview, and Log follow the content tabs.
- D3. The story view is a mode of Timeline, not a ninth tab.
- D4. A person's event text outlives a re-record until the person releases the mark, and a rebuild's replacement
  under D7's condition. A fresh rebuild discards it, as it discards every mark.
- D5. A person's note page survives a rebuild, starts at `contextMode: "auto"`, and the writer may change any section
  of it that is not locked.
- D6. A rename keeps the old title as an alias, because titles and aliases are how retrieval and the writer's cast
  find a page.
- D7. A rebuild regroups turns when the cadence or the screening changed, so one staged event may cover several live
  events or part of one. Text crosses only when one corrected event covers exactly the staged event's messages;
  otherwise the mark crosses alone, as today, and the text of a replaced event is gone, while an event the swap carries
  keeps its text. `lifecycle.md` records it as a limitation.
- D8. A rename, an alias edit, and a section's addition write no new history kind, and a person's `create` and `edit`
  entries reuse existing kinds, so a build from before this plan still restores a chat file written after it.

## Not In This Plan

- Deleting a section by hand, changing a page's type, and editing `links`.
- Editing an event's key lines, state changes, knowledge, or participants.
- Help text for 기록기, 억제, and 채택, which stay as they are.
- A Korean rename of the shared memory surfaces (the settings page, the preset, the toggle, the meter).
- Markdown rendering of record text, and a natural-language command terminal.
- An `e2e` spec for the panel: none exists today, and the panel test mounts the real components.
- The open real-model A/B of [manual checks](../backlog/manual-checks.md) (Structured Memory Q2).

## Open Questions

None open. The owner answered D1 to D6 on 2026-11-11.
