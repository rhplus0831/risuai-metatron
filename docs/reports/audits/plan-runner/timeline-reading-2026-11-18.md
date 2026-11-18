# Timeline Reading View Plan audit, 2026-11-18

- Plan: `docs/plan/timeline-reading.md`
- Commit audited: `de6954fee`, the commit that added the plan. The corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6.2-Astra (`xhigh`), read-only, at the owner's request in place of the procedure's Sol because slices 1
  and 3 change `shared/` and `server/` contracts; report written by the session that drafted the plan (Claude Fable
  5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 1     |
| P2         | 7     |
| P3         | 13    |
| unverified | 1     |

All 22 findings are closed and `fixed in plan`. The first turn filed R1 to R14 against the draft. The second turn read
the corrections, confirmed eleven, disputed R1, R2, and R6, and filed R15 to R21 against the corrections themselves
(R15, the one P1, was a failure path the correction of R2 had promised without a place to show it). The third turn
confirmed those and filed R22; the fourth confirmed R22 and found nothing open.

Astra changed no file in the repository (`read_only_violation` was `false` after each turn) and ran no test or type
check: the audit is a reading of the code. The four turns took about 19 minutes and 7.8 M tokens.

Re-check list: slice 3 touches job admission only through the settings fingerprint. `patchMessage` closes an open
generation fence (`server/src/data/chatStore.ts:2584`), and delivery needs an eligible socket whose send succeeds
(`server/src/jobs/generationJobs.ts:1059`, `:1074`), so the README's `sendText` entry is broader than the code;
neither is used by the fingerprint change. `/story` uses existing reads (`server/src/routes/structuredMemory.ts:946`)
and `STORE_TABLES_SQL` runs on a fresh database (`server/src/data/resourceStore.ts:3861`, `:798`); the plan adds no
table and no feed row.

Found consistent (paths under `src/lib/Others/StructuredMemory/` unless they say otherwise):

- **The rows hold what both views need.** The tab reconciles before `memoryTimelineRows`; each row carries the event,
  `position`, and a nullable `turnsAgo`; order is stable ascending with the greeting at -1 and unplaced rows at
  `Infinity` (`TimelineTab.svelte:116`, `src/ts/process/structuredMemory.svelte.ts:1889`, `:2110`, `:2139`). Manage
  can reorder locally, and Read can filter retractions and join dates, summaries, and grades by id.
- **Read can keep the story guards.** Story starts one read per `refresh` while selected, `storyRead` is set before
  dispatch, `storyNumber` and the chat identity reject late answers, and a text edit rereads coverage, the open
  record, and the visible story (`TimelineTab.svelte:87`, `:229`, `:294`). The panel remounts the tab on a chat
  change (`StructuredMemoryPanel.svelte:703`).
- **Story's consumers are known.** The Timeline is the only production consumer of story rows; the route test has the
  exact-key loop (`server/src/tests/structuredMemoryRoutes.test.ts:936`) and two client tests use `toStrictEqual` on
  parsed rows (`src/ts/process/structuredMemory.test.ts:497`, `:534`), which stay valid for rows without a grade.
- **Dates, importance, and the chapter plan's needs line up.** `formatStoryDate` keeps the year distinction
  (`shared/structuredMemory.ts:431`), `storyDateDistance` is anchor-relative (`:466`), the grade maximum is 9 and the
  importance threshold 6 (`:194`), which Pages uses for its badge (`PagesTab.svelte:1792`).
- **An old preset reads as 10.** `chatHypaV3Preset` selects without normalizing (`shared/chatMemory.ts:50`), Coverage
  normalizes its result (`CoverageTab.svelte:88`), preset creation, import, and the server's collection normalizer
  normalize `structured` (`shared/hypaV3Presets.ts:61`, `server/src/data/normalize/collections.ts:249`), and
  `integerIn` rejects strings, fractions, and out-of-range values (`shared/structuredMemory.ts:2003`).
- **The fingerprint exclusion is sufficient.** The general digest drops the whole `structured` object and only the
  Structured Memory branch adds it back without the three highlight fields (`server/src/jobs/jobScope.ts:412`,
  `:460`, `:472`); no second whole-`structured` digest exists. The highlight test exercises the same boundary
  (`server/src/tests/memoryTaskHost.test.ts:551`).
- **A known mixed-version limit applies.** A tab loaded before the field existed rebuilds `structured` from its old
  normalizer on its next settings edit and can reset a non-default group size to 10
  (`src/lib/Setting/Pages/MemorySettings.svelte:274`); `writer.md` already records this limitation for every
  Structured Memory field, and the upstream exporter strips these settings by design.
- **The search request can be shared.** Each tab can hold its own helper state with getters for chat, `refresh`, and
  the trimmed draft; Pages keeps its raw query, title filter, IME state, and display gates (`PagesTab.svelte:249`,
  `:288`, `:386`, `:636`, `:2133`, `:2171`).
- **The serial order is sound**, and `read.md` is at 34,605 bytes of 40,000 (`util/docsBudget.mjs:55`).

## P1

### R15 — Slice 4: a hit that coverage lacks had no place to show its failure — fixed in plan

- Plan (Slice 4, after the first correction): "one that is gone shows the record read's own failure."
- Code: the focus lookup returns before `openRow` when the id is not among the rows (`TimelineTab.svelte:401`), and
  `openFailure` renders only inside an expanded row (`:419`, `:653`). Search and coverage are independent reads.
- Correction, confirmed (with R22): when settled coverage has no row with the id, the tab reads coverage once more;
  after an accepted, successful reread it reveals the event if present and otherwise shows one line at tab level
  saying the event is no longer recorded, and drops the target.

## P2

### R1 — Slice 2: focus could be consumed before its row was visible — fixed in plan

- Plan (Slice 2): "Read opens the event's group, opens the event, and scrolls to it. A retracted event ... switches
  the view to Manage first."
- Code: the effect searches `visibleRows`, marks the target handled before `tick()`, and raises a flat row limit
  (`TimelineTab.svelte:130`, `:172`, `:393`); coverage can arrive before the story's dates.
- Correction, confirmed (with R16): one "Revealing an event" rule that resolves the id among all reconciled rows,
  picks the view, raises the row or group limit, opens the event, and keeps the target pending until its row is
  rendered, across a view switch and an outstanding story read.

### R2 — Slice 4: `/find` guarantees status only at the search's revision — fixed in plan

- Plan (Slice 4): "`/find` skips retracted events, so no hit needs the Manage view."
- Code: the route filters retracted events (`server/src/routes/structuredMemory.ts:985`), but the tab reads search
  and coverage independently (`src/ts/process/structuredMemory.svelte.ts:1327`, `:1363`).
- Correction, confirmed: an event hit clears the search and goes through the reveal rule; an event the coverage read
  shows retracted opens in Manage, and one coverage lacks takes the rule's last step.

### R3 — Slice 2: the greeting source link carries repair controls — fixed in plan

- Plan (Slice 2): "the source links that jump to the chat" and "No edit control, no repair ... in Read."
- Code: the source block mounts `GreetingCitation`, which renders the jump and Re-record, Rebuild, and Keep
  (`GreetingCitation.svelte:44`, `:84`); `readOnly` disables but does not hide them. A changed greeting can sit on
  an active, unmarked event (`StructuredMemoryPanel.test.ts:4167`).
- Correction, confirmed: Read renders a greeting citation as its jump alone, Manage keeps the full citation, and the
  notice counts each stale or marked event once and not a greeting-only discrepancy.

### R4 — Slice 4: copying Pages' form does not bound the Timeline's input — fixed in plan

- Plan (Slice 4): "The Timeline's Read view gains the same form ... an input bounded by `MEMORY_FIND_QUERY_CHARS`."
- Code: Pages bounds the trimmed submission, not typing (`PagesTab.svelte:249`, `:413`); `TextInput` forwards no
  `maxlength` (`src/lib/UI/GUI/TextInput.svelte:8`); the Timeline's empty-state branch precedes its list
  (`TimelineTab.svelte:588`).
- Correction, confirmed: Pages keeps its input as it is; the Timeline has its own form with a native input and
  `maxlength`, placed outside the empty-state branch.

### R16 — Slice 2: revealing a row no longer opened the event — fixed in plan

- Plan (Slice 2, after the first correction): "It keeps the current view when that view lists the event" and then
  "makes the row visible."
- Code: focus calls `openRow(target.id)` before scrolling (`TimelineTab.svelte:242`, `:405`), and the Pages
  navigation test asserts `aria-expanded="true"` (`StructuredMemoryPanel.test.ts:925`).
- Correction, confirmed: "Open in Manage" and the notice's button select Manage first; a `focus` and "Open in Manage"
  open the event as a press does; the notice's button only reveals the row.

### R17 — Slice 3: the wrong argument to the normalizer — fixed in plan

- Plan (Slice 3, after the first correction): normalize "what `chatHypaV3Preset` returns with
  `normalizeStructuredMemorySettings`."
- Code: the selector returns a preset with `settings` (`shared/memory.ts:122`); Coverage passes
  `preset?.settings.structured` (`CoverageTab.svelte:88`); the normalizer reads fields from its input
  (`shared/structuredMemory.ts:2017`), so the preset itself would always yield 10.
- Correction, confirmed: pass `normalizeStructuredMemorySettings(preset?.settings.structured).eventsPerGroup`.

### R22 — Slice 2: a failed coverage reread cannot show that an event is gone — fixed in plan

- Plan (Slice 2, after the second correction): "If the id is still absent, the tab shows one line saying the event
  is no longer recorded and drops the target."
- Code: `read()` replaces `facts` only on success; a failed or refused read keeps the old rows, and a superseded or
  wrong-chat answer updates nothing (`TimelineTab.svelte:145`).
- Correction, confirmed: only an accepted, successful reread decides; a failed or refused one shows the coverage
  error, and a superseded or wrong-chat answer is ignored.

## P3

Each is `fixed in plan`; the corrected text is in the plan.

- **R5 — Current State.** "exactly those four fields as stored" and "an event without complete axes has none"
  overstated two writer invariants: a restored chat file can carry any finite `grade`
  (`server/src/prompt/memory/structured/restore.ts:58`, `:204`), and the route projects named properties that JSON
  omits when undefined (`server/src/routes/structuredMemory.ts:955`). Reworded.
- **R6 — Slice 2, selectors.** Keeping attribute names does not keep the Pages search test, which expects a
  direct-child toggle with `aria-expanded` and a summary its fixture serves from the record route
  (`StructuredMemoryPanel.test.ts:770`, `:925`). The rule now names the toggle and the fixtures.
- **R7 — Order.** The Order section and the slices' file lists disagreed; slice 2 also edits a comment in the client
  module and a test title (`src/ts/process/structuredMemory.svelte.ts:131`,
  `src/ts/process/structuredMemory.test.ts:546`), and the records guide names the story view (`records.md:59`).
- **R8 — Slice 2, test location.** A new file under `shared/tests/` resolves to the persistence guide in
  `docs/structure/ownership.json`; the cases go in `shared/structuredMemory.test.ts`, and `pnpm check:tests` joins
  the checks.
- **R9 — Slice 3, fixture.** The boot fixture and the normalizer suite's whole-object expectations compare the
  normalized settings (`src/ts/storage/tests/bootSnapshot.test.ts:215`,
  `server/src/tests/normalizeCollections.test.ts:664`, `:942`), so both are mandatory.
- **R10 — Slice 3, guides.** The fingerprint's exceptions and the preset fields are in `structured-memory/writer.md`
  (`:234`, `:263`, `:283`) and the panel's preset readers in `read.md:137`; slice 3 lists both.
- **R11 — Slice 4, notice.** `more` can be set by an unread continuation with no further match
  (`src/ts/process/structuredMemory.svelte.ts:1376`); the plan now names Pages' "Showing the first 200 matches".
- **R12 — Slice 3 and D4, help text.** A chapter can hold up to twice the size less one, so the option is its target
  size.
- **R13 — Slice 1.** It listed no manual check; it now says it has none of its own.
- **R18 — Slice 2, fixtures.** The page-mentions test defines its own event (`StructuredMemoryPanel.test.ts:988`,
  `:1055`); each fixture now serves `/story` rows from its own events.
- **R19 — Current State.** Grade validation was described as present; slice 1 adds it
  (`src/ts/process/structuredMemory.svelte.ts:687`).
- **R20 — Slice 3.** The boot test compares preset entries and the normalizer suite the `structured` object; the
  sentence now says which compares what.
- **R21 — Slice 2, Files.** `GreetingCitation.svelte` is listed, conditionally.

## unverified

- **R14 — D3.** "The owner's chats track the date in every message, so nearly every event is dated" is the owner's
  report, which the code cannot settle; the date is optional (`shared/structuredMemory.ts:515`). D3 is now worded as
  the owner's report and says the rule handles undated events.
