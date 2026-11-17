# Structured Memory Story Dates Plan

Status: drafted 2026-11-18 at `3b5d7ce6f` from the user's request of the same day and committed at `aafebc9c0`, then
audited against the code at that commit
([report](../reports/audits/plan-runner/structured-memory-story-dates-2026-11-18.md)) and corrected in the same commit
as the report. The goal and the status line formats are the user's; D1 to D7 are this plan's own and open to the
user's change. The fold rule of slice 1, the limits on custom prompts and replays, the scope of the unchanged-card
rule, and D7's wording took their present form from the audit. Landed: none.

Sources: `MemoryEventDraft`, `MemoryEvent`, `memorySourceText`, `StructuredMemoryStoryEvent`, and
`STRUCTURED_MEMORY_LIMITS` in `shared/structuredMemory.ts`; `readStoryTime` and `parseAnalysis` in
`server/src/prompt/memory/structured/analysis.ts`; `FORMAT`, `RULES`, `PATCH_RULES`, `shownText`, and `patchSlots` in
`server/src/prompt/memory/structured/prompts.ts`; `isEvent` in `server/src/prompt/memory/structured/restore.ts`;
`eventBody`, `flowLine`, `flowEventLine`, `eventLine`, `RULE_HEADER`, `renderParts`, `frameTokens`,
`preflightMemoryCard`, and `buildMemoryCard` in `server/src/prompt/memory/structured/card.ts`; `PlacedEvent`,
`prepareRetrieval`, `flowItems`, and `retrieveLanes` in `server/src/prompt/memory/structured/retrieve.ts`; the card
calls of `server/src/prompt/memory/structured/step.ts`; `renderMemoryTimeline`, `runEventView`, and the story read of
`src/ts/process/structuredMemory.svelte.ts`; `storyTimeText` in `src/lib/Others/StructuredMemory/TimelineTab.svelte`;
`src/lib/Others/StructuredMemory/LogTab.svelte`. The identifiers are the anchors. Re-verify each cited location before
editing (STRUCTURE.md protocol step 5).

Owning guide: [structured-memory](../structure/structured-memory/README.md), topics
[records](../structure/structured-memory/records.md), [writer](../structure/structured-memory/writer.md), and
[read](../structure/structured-memory/read.md).

## Goal

The main model handles dates in the memory card badly: it has to subtract the date on an event from the story's
current date, and in practice it calls most past events "yesterday". The user wants the card to say how long ago an
event was (days, weeks, months), so the main model does not have to work it out.

Many chats state the date in every reply, in a status line the main model writes into the message and a display
script then draws. The user's own and the common community forms:

```text
[Nu|2025년 4월 3일 목요일|아침|재원의 방]

<status>date:2025/10/27 (월)|...

<STATUS>
time=19:40
date=10월 15일 (목)
```

The third form states no year.

After this plan the writer copies a stated date into the event as a structured field, and the card puts the distance
from the story's newest recorded date before each dated event: `(2 weeks ago, 3월 17일 저녁) title: summary`. A chat
whose events hold no date gets no label and no anchor line: its stored records render as they do today.

## Current State

- **The writer already reads the status line.** A message reaches the writer as `shownText`, which is
  `memorySourceText`: tags and comments are removed and their inner text is kept. All three forms above keep their
  date text. A status line drawn only by a display script from a chat variable is not in the stored message and is not
  read; that case is out of this plan.
- **Story time is free text.** `MemoryEventDraft.storyTime` is `{ text, ordinal? }`. `FORMAT` asks for
  `"storyTime": { "text": "when this happens in the story, or empty" }`; `readStoryTime` clamps the text to
  `labelChars` and keeps a finite `ordinal`. `FORMAT` does not ask for `ordinal`, and nothing orders by it: it is
  parsed, stored, checked by `isEvent`, and shown in the panel in parentheses.
- **The card shows the text as written.** `eventBody` renders `(<story time>) <title>: <summary>` with key lines; the
  events lane uses it through `eventLine` and the recent timeline through `flowEventLine`, which leads with
  `<N> turns ago: `. The title-only flow line (`flowLine`) is `<N> turns ago: <title>`. No code computes a distance in
  story time.
- **Retrieval places the events a send can read.** `prepareRetrieval` builds `placed`: the readable, active,
  unsuppressed events that have a current source entry or a greeting entry, events whose messages are still in the raw
  window included. `place` is the event's newest matched entry index; `placed` itself is not sorted. `flowItems` and
  the events lane build their lines from it.
- **The card's frame is counted.** `renderParts` puts `RULE_HEADER` at the top of the stable part; `frameTokens`,
  `preflightMemoryCard`, and `buildMemoryCard` count that frame against the maximum.
- **The patch call sees the event's story time.** `patchSlots` passes `storyTime` whole in the event JSON.
- **Stored events are not shape-checked on write.** A record is JSON; `checkMemoryRow` checks a row's columns. The
  restore and package import check is `isEvent`, whose `shaped` leaves a field it does not name alone. The package's
  timeline file writes every event field but `summary` as JSON (`metadataLines`).
- **The panel rebuilds story time from two fields.** The story read and `runEventView` in
  `src/ts/process/structuredMemory.svelte.ts` copy `text` and `ordinal` only, so a new field does not reach
  `TimelineTab.svelte` or `LogTab.svelte` until they pass it.
- **The default cadence is every turn**, so the newest recorded event is normally one confirmed turn behind the chat.
  A `tokens` or `everyK` cadence, a paused writer, or a failing one leaves it further behind.

## Rules For Every Slice

- No wall clock: a story date is never compared with `Date.now()`. The date helpers are pure functions.
- The same stored records with no valid date render as before: no anchor line, no label, the same token counts. D5
  changes the wording of records written from then on, dated or not, so a later card can differ through them.
- The card's own words stay English; a date's text stays as the writer wrote it.
- `storyTime.ordinal` keeps its meaning and its handling. No slice reads it for the label.
- An event stored before this plan stays undated, and so unlabelled, until it is re-recorded, rebuilt, or folded
  into by a repeat that carries a valid date (slice 1). No slice adds a migration or a backfill pass of its own.
- User-visible strings go to `src/lang/en.ts` with their Korean text in `src/lang/ko.ts`; other locales fall back.
- V1 to V9 apply. Each slice updates the guides it names (`pnpm docs:owner <path>`, `pnpm check:docs`). Full checks:
  `pnpm check`, `pnpm check:docs`, `pnpm format:check`, `pnpm --silent test:agent`.
- `docs/structure/structured-memory/read.md` was 539 bytes under its size budget at `3b5d7ce6f`. Slices 2 and 3 shorten
  or move as much text there as they add.
- Workflows: `opus-lite` for a slice without a size, `opus-workflow` for a _hard_ slice.

## Order

1, then 2, then 3. Slices 2 and 3 use the field and helpers of slice 1 and nothing of each other, but both edit
`docs/structure/structured-memory/read.md`, so they run one after the other.

## Slice 1. The writer records a stated date (`records.md`, `writer.md`, `lifecycle.md`)

- **The field (D1).** `MemoryEventDraft.storyTime` gains `date?: MemoryStoryDate`, where
  `MemoryStoryDate = { year?: number; month: number; day: number }`. In `shared/structuredMemory.ts`, beside it:
  - `parseStoryDate(text: string): MemoryStoryDate | undefined` reads `YYYY-MM-DD` or `MM-DD`, with `-`, `/`, or `.`
    between the parts and one or two digits for month and day. It refuses a year outside 1 to 9999, a month outside 1
    to 12, and a day the month does not have (February has 29 days when there is no year).
  - `formatStoryDate(date): string` gives `2025-04-03` or `10-15`.
  - `isStoryDate(value): value is MemoryStoryDate` is the same validity rule over a stored object.
- **The answer (D2).** `FORMAT` asks for the date:
  `"storyTime": { "text": "when this happens in the story, or empty", "date": "YYYY-MM-DD, or MM-DD with no year stated; only a date the messages state" }`.
  `RULES` gains one rule. Proposed wording, which the manual check may tune:

  ```text
  - storyTime.date is the calendar date a message under "Messages to record" states, as in a status line or header: "2025년 4월 3일" is "2025-04-03", "10월 15일" with no year is "10-15". When the messages state several, use the last. Never calculate or guess one, never take it from the context, and leave it out for a calendar that is not year, month and day.
  ```

- **Parsing.** `readStoryTime` reads a string `date` through `parseStoryDate` and keeps the result; anything else,
  and a string that does not parse, leaves the field out without a warning, as a missing story time does today.
- **A folded repeat.** When admission folds a recording into the chat's last event (`repeatsEvent`), the written event
  is the stored one with more sources, and the answer's story time is dropped. The fold keeps the stored
  `storyTime.text` and takes the answer's `storyTime.date` when it holds a valid one, so an event's date stays the last
  date its messages state. An answer with no date leaves the stored date. The fold's comment in `analysis.ts`, which
  says everything else on the event stays, is updated with it.
- **Stored and restored.** `isEvent`'s story time check gains `date: optional(isStoryDate)`, so a restored or imported
  record with a malformed date is refused as any malformed field is. The package format does not change:
  `metadataLines` already writes the field, an older build's `isEvent` leaves it alone, and `MEMORY_PACKAGE_VERSION`
  stays 2.
- **Relative words (D5).** `RULES` and `PATCH_RULES` each gain one rule. Proposed wording:

  ```text
  - A summary, a fact, and a page's text are read long after they are written: never write a word that depends on the day it is read (today, yesterday, tomorrow, tonight, this morning, last night). Name the date when the event has one, otherwise the time of day or what it followed.
  ```

  Quotes stay verbatim and the scene's `time` field is not covered: the scene is the present.

- Fixtures: `scriptedWriter.ts` and `story.ts` under `server/src/tests/fixtures/memory/structured/` type their story
  time as `{ text }`; widen them only as far as the new tests need.
- Tests:
  - `shared/structuredMemory.test.ts`: `parseStoryDate` for each accepted form and each refusal, `formatStoryDate`,
    and `memorySourceText` keeping the date text of the three status line forms in **Goal**.
  - `analysis.test.ts`: a string date is kept, a year-less one is kept without a year, an impossible or non-string
    one is left out and the event still parses, an answer with no `date` parses as today. A fold takes the answer's
    valid date and keeps the stored text; a fold with no date in the answer keeps the stored date.
  - `prompts.test.ts`: the analysis format names `date`, and the patch event slot carries a stored date.
  - `restore.test.ts`: an event with a valid date restores, one with a malformed date is refused, one with no date
    restores as today.
  - `importPackage.test.ts` or the package round trip that exists there: a dated event comes back with its date.
- Guides: records (the event's fields and what a loaded event can lack), writer (what the analysis answer holds, the
  two new rules, and the fold), lifecycle (restore admission keeps a valid date and refuses a malformed one).
- After this slice an event recorded from a newly assembled default prompt carries a date when the messages state one.
  A custom analysis frame gets the new format and rules only where it quotes `{{slot::format}}` and `{{slot::rules}}`,
  and a custom patch frame the relative-word rule only through `{{slot::rules}}`. A retry that replays a stored
  `input` sends the instructions that input was built with. Nothing reads the date yet.

## Slice 2. The card says how long ago (_hard_, `read.md`)

- **The story date (D3).** In `prepareRetrieval`, the story date is the `storyTime.date` of the `placed` event with
  the greatest `place` among those that have a valid date; with none, there is no story date. It is returned with the
  prepared values and by `retrieveLanes`.
- **The distance (D4).** `storyDateDistance(from: MemoryStoryDate, now: MemoryStoryDate): number | undefined` in
  `shared/structuredMemory.ts` gives whole days from `from` to `now`, on the Gregorian calendar through UTC day
  numbers:
  - Both with a year: the plain difference.
  - A missing year is taken as the nearest one that puts `from` on or before `now`. With `now` at `2025-04-03`, `12-25`
    is `2024-12-25`. With `from` at `2024-12-25` and `now` at `04-03`, `now` is `2025-04-03`. With neither, `now` takes
    a leap reference year and `from` that year or the one before.
  - A day the assumed year does not have (February 29) takes that month's last day.
  - A negative result is `undefined`: the event is after the story date (a scene set in the future, or the story date
    moved back).
- **The label.** `storyDateLabel(days: number): string`:

  | Days        | Label          | Count                  |
  | ----------- | -------------- | ---------------------- |
  | 0           | `same day`     |                        |
  | 1           | `1 day ago`    |                        |
  | 2 to 13     | `N days ago`   | the days               |
  | 14 to 59    | `N weeks ago`  | `floor(days / 7)`      |
  | 60 to 729   | `N months ago` | `round(days / 30.44)`  |
  | 730 or more | `N years ago`  | `round(days / 365.25)` |

- **The lines.** `eventBody` takes an optional label and renders the parenthesis as the label, then the story time
  text, joined by `, `; either alone stands alone, and with neither there is no parenthesis, as today:
  - events lane: `(2 weeks ago, 3월 17일 저녁) title: summary`
  - recent timeline: `12 turns ago: (3 days ago, 3월 31일 저녁) title: summary`
  - title-only flow line: `154 turns ago: (2 months ago) title`

  `eventLine`, `flowEventLine`, and `flowLine` take the label from their callers in `retrieve.ts`, which compute it
  once per event from the story date. A candidate's `plain` form carries the same label as its full form. Vector
  texts (`eventVectorTexts`) do not change: a label is never embedded.

- **The anchor line (D6).** When there is a story date, the stable part's header is `RULE_HEADER` and a second line:

  ```text
  Story date at the newest record: 2025-04-03. An event's "N days ago" counts back from it.
  ```

  `renderParts` takes the story date, and every count of the frame passes it: `frameTokens`, `preflightMemoryCard`,
  and `buildMemoryCard`, with the three card calls in `step.ts` (the first card, the evidence reselection's card, and
  the preflight). The required-lane refusal therefore counts the line. With no story date the header is `RULE_HEADER`
  alone.

- Tests:
  - `shared/structuredMemory.test.ts`: `storyDateDistance` for each rule above (both years, each missing-year case, a
    year boundary, February 29, a negative result) and `storyDateLabel` at each boundary of the table.
  - `card.test.ts`: each of the three line forms with a label and text, a label alone, text alone, neither; the
    header with and without a story date; `frameTokens` and the preflight count the second line.
  - `retrieve.test.ts` or `lanes.test.ts`: the story date is the newest dated event's by `place`, not by stored
    order; an undated newer event does not hide an older dated one; an event dated after the story date has no label;
    a chat with no dated event yields today's lines unchanged.
  - `server/src/tests/fixtures/memory/structured/` harness: one send over a dated story whose card holds the anchor
    line and a label, if the harness story can carry dates at small cost; otherwise the unit tests stand.
- Guides: read (the read path's flow and events lane lines, the header, and under `Limitations` the lag in **Limits**
  below).
- After this slice the main model reads the distance on every dated event of the card. Preview shows the same lines,
  since it shows the card.

## Slice 3. The panel shows the date (`read.md`)

- The story read and `runEventView` in `src/ts/process/structuredMemory.svelte.ts` pass a valid `date` through
  (`isStoryDate`), and the opened-event read of the Timeline does the same wherever it rebuilds story time.
- `storyTimeText` in `TimelineTab.svelte` and the story time line of `LogTab.svelte` show the date first, as
  `formatStoryDate` gives it, then the text, then the ordinal in parentheses as today: `2025-04-03 · 아침`. A date
  with no text shows alone: the three guards that hide the line while the text is empty (the Timeline's opened event
  and story row, the Log's event) show it for a date too, and the run view's own story time type gains the field. No
  new string is needed while the existing `storyTime` label leads the line; add one only
  if the layout needs it.
- `StructuredMemoryPageMention.storyTime` stays the text. Pages' mention rows do not show the date.
- Tests: the story read and the run view keep a valid date and drop a malformed one; the Timeline's opened event and
  story row and the Log's event show the date (`StructuredMemoryPanel.test.ts` or the tab tests beside it).
- Guides: read (`Pages, Timeline, and Threads`, and the Log's event view).
- After this slice a person can see which date the writer read for an event, which is how a wrong label is traced.

## Decisions

- **D1. A structured date beside the text, not a parsed text.** `storyTime.text` stays what the writer wrote, in the
  chat's language. Rejected: parsing `text` in code (the text is free, and "the evening of the festival" is as valid
  as a date); reusing `ordinal` as a day number (it cannot say "no year", and its stated meaning is an ordering key).
- **D2. The writer copies the date; code does not search the messages for one.** The writer already reads the window
  and status lines differ from bot to bot. Rejected for now: a date pattern in the settings (see **Not In This
  Plan**).
- **D3. The story date is the newest dated event's, derived on each send.** Nothing new is stored, so retraction, a
  rebuild, a branch copy, a checkpoint, and an import need no rule of their own: the story date follows whatever
  events are active. Rejected: a date on the scene page (a second stored value with its own lifecycle and editor).
- **D4. A missing year means "within the past year".** Status lines that never state a year are common. A chat whose
  story runs longer than a year without ever stating one gets distances that are short by whole years.
- **D5. Summaries and pages name the date instead of "yesterday".** A stored "yesterday" is wrong the next story day,
  and it is the same error the label is meant to remove. This changes the wording of every new record, also in chats
  with no dates, where the rule asks for a time of day or what the event followed.
- **D6. The card states the date the distances count from.** The story date is the newest recorded one, not the date
  of the last message (see **Limits**). With the anchor the main model can see a difference between it and a status
  line in the recent messages, and `RULE_HEADER` already says recent messages win.
- **D7. No verification of the date against the messages.** A quote is checked verbatim; a date is a normalized
  value and has no verbatim form to check. It is as trusted as `storyTime.text` is today. A wrong date on the
  event the story date is read from skews every label until another dated event has the greatest `place`, or a fold
  into that event carries a valid date (slice 1). An undated recording does not replace it, and neither does a
  recording of an older window, whose event is placed earlier. With a status line in every reply and the default
  cadence, the next recorded turn replaces it.

## Limits

- **Lag.** The story date is behind the chat by the unrecorded tail: one confirmed turn under the default cadence,
  more under a `tokens` or `everyK` cadence or while the writer is paused or failing. When the story's day changes
  inside that tail, every label is short by that many days until the tail is recorded. The anchor line states the date
  used.
- **Chats that state no date** get no label, and events between two status lines that carry none get none.
- **Custom prompts and replays.** A preset's custom frame gets the new format and rules only through the format and
  rules slots; a frame without them says what its author wrote. A replayed input asks what it asked when it was
  built.
- **Other calendars** (an in-world era, "Day 12") are left out by the writer's rule and get no label.
- **Text inside pages** is not relabelled. A page says what the patch call wrote; D5 keeps relative words out of it.
- **Cache.** The stable part changes when the story date changes, about once per story day, and each dated flow line
  changes with it.

## Not In This Plan

- **A status line drawn from chat variables** and not written into the message.
- **A date pattern in the settings** that code applies to the newest message for an exact, lag-free story date.
- **Editing an event's date in the panel.** A re-record or a rebuild reads it again.
- **Day counts for calendars that are not year, month, and day**, and a use for `storyTime.ordinal`.
- **Time of day arithmetic** ("three hours ago").
- **Ordering or filtering events by date**, in the card or the panel.
- **Labels on threads, pages, and evidence lines.**

## Manual Checks

For the user, after slice 3, with a real writer model. Unrun ones go to the manual checks backlog when the plan
closes.

1. A chat whose replies open with `[Nu|2025년 4월 3일 목요일|아침|재원의 방]`: after a recorded turn the Timeline shows
   `2025-04-03` on the event.
2. The `<status>date:2025/10/27 (월)|...` form and the `<STATUS>` block form with `date=10월 15일 (목)`: the first
   records `2025-10-27`, the second `10-15`.
3. Move the story on by several days and record: Preview shows the anchor line with the new date and `N days ago` on
   the older events, and an event two months back says `2 months ago`.
4. A chat that never states a date: Preview has no anchor line and no label.
5. Ask the main model about an event from several days earlier: its reply places the event at the right distance and
   does not call it "yesterday".
6. Rebuild a chat recorded before this plan: its events gain dates and labels.
7. Read ten new summaries and the pages they touched: none says "오늘", "어제", or "내일" for the event's own time.
8. A reply that only mentions a date in dialogue ("내 생일은 12월 25일이야") with no status line: the event records
   no date, or the Timeline shows the wrong one and the wording of the rule in slice 1 needs tuning.
