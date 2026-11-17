# Structured Memory Story Dates Plan audit, 2026-11-18

- Plan: `docs/plan/structured-memory-story-dates.md`
- Commit audited: `aafebc9c0`, the commit that added the plan. The corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, in place of the procedure's Sol because slices 1 and 2 change `shared/` and
  `server/` contracts; report written by the session that drafted the plan (Claude Fable 5.2), before any plan-runner
  run

| Severity   | Count |
| ---------- | ----- |
| P1         | 0     |
| P2         | 5     |
| P3         | 4     |
| unverified | 0     |

All nine findings are closed and `fixed in plan`. The first turn filed A1 to A6. The second turn read the drafted
corrections, confirmed A1, A2, and A4 to A6, disputed A3 (the new fold rule works, but two sentences around it were
still wrong), and filed A7 to A9 against the corrections themselves. The third turn confirmed A3 and A7 to A9 and
found nothing new.

Astra changed no file in the repository (`read_only_violation` was `false` after each turn) and ran no test or type
check: the checkout has no `node_modules`, and the audit is a reading of the code. The three turns took about 12
minutes and 4.1 M tokens.

Re-check list: the plan adds no job, feed row, table, or notice. `patchMessage` closes the generation fence
(`server/src/data/chatStore.ts:2584`), and the writer's receipts go through it
(`server/src/prompt/memory/structured/writer.ts:495`), which the plan does not change. Feed rows are measured whole (`chatStore.ts:1942`); the plan changes no row. `STORE_TABLES_SQL` runs at
version 0 (`server/src/data/resourceStore.ts:3862`, and for a new snapshot output database at `:798`); the optional
date lives inside the event's JSON (`server/src/data/memoryStore.ts:516`), so no table changes. `sendText` is not
touched; the auditor noted that the entry's premise no longer matches the code, which needs an eligible socket to
accept the send (`server/src/jobs/generationJobs.ts:1065`, `:1074`).

Found consistent (paths under `server/src/prompt/memory/structured/` unless they say otherwise):

- **The field's path.** Besides the places the plan names, nothing rebuilds an event's story time field by field: the
  memory store writes and reads the record whole (`server/src/data/memoryStore.ts:516`, `:628`), as do checkpoint
  validation (`server/src/data/checkpointStore.ts:727`), branch copies (`inherit.ts:118`), the rebuild swap
  (`rebuild.ts:497`, `:561`), a re-record's replacement (`reconcile.ts:336`), the `eventText` edit (`edits.ts:404`),
  and the `/story` route (`server/src/routes/structuredMemory.ts:955`). Adoption writes an undated event
  (`adopt.ts:111`).
- **The package.** `/package` returns the whole event (`server/src/routes/structuredMemory.ts:883`), `metadataLines`
  writes each field as JSON (`src/ts/process/structuredMemory.svelte.ts:1518`, `:1526`), the importer parses each
  value as JSON and validates through `parseRestoredRecords` (`importPackage.ts:113`, `:233`, `:291`), and `shaped`
  leaves an unnamed field alone (`restore.ts:79`, `:178`). `MEMORY_PACKAGE_VERSION` stays 2
  (`shared/structuredMemory.ts:1125`).
- **The card's consumers.** Nothing parses or compares a line's wording: tags and the manifest go by identity
  (`shared/structuredMemory.ts:1303`, `server/src/prompt/assemble.ts:3156`), token caches key the text itself
  (`server/src/prompt/tokens.ts:187`, `:253`), cache points go by role and position (`assemble.ts:2450`, `:2476`),
  the full, plain, and title forms of a flow candidate are built together (`retrieve.ts:429`, `:436`, `:438`), and
  vector texts leave story time out (`retrieve.ts:244`).
- **The frame's callers.** `renderParts` is called at `card.ts:198`, `:281`, `:301`; `frameTokens` at `:221`, `:288`;
  `preflightMemoryCard` at `step.ts:297`; `buildMemoryCard` at `card.ts:213`, `step.ts:301`, `:350`. The preflight
  runs after `prepareRetrieval` (`step.ts:287`), so the story date is available to it.
- **The panel.** The story row reads through `parseStoryRound` (`src/ts/process/structuredMemory.svelte.ts:672`), the
  opened event and the Log through `runEventView` (`:2384`, `:2435`, `:2468`), and the three guards are
  `TimelineTab.svelte:492`, `:624`, and `LogTab.svelte:143`.
- **The cadence.** The default is `everyTurn` (`shared/structuredMemory.ts:1895`); the next user message confirms the
  previous reply (`window.ts:130`), and selection runs before the hand-off (`server/src/prompt/assemble.ts:687`,
  `server/src/prompt/runner.ts:750`), so a send's card is one confirmed turn behind when earlier work has finished.
- **The test files** the slices name exist, and slices 2 and 3 share no file but `read.md`, whose budget leaves 539
  bytes (`util/docsBudget.mjs:55`).

## P2

### A1 — Slice 1: custom prompts and replays do not get the new instructions — fixed in plan

- Plan (Slice 1): "After this slice new events carry a date when the messages state one."
- Code: a custom analysis frame must quote only `messages` and `scene` (`prompts.ts:66`), and `buildPrompt` fills only
  the slots a frame quotes (`writer.ts:339`). A failed run's stored `input` is sent again without building a prompt
  (`writer.ts:354`, `:581`), and its fingerprint covers settings, not the prompt constants
  (`server/src/jobs/jobScope.ts:439`). A custom patch frame can leave out the rules slot too.
- Correction, confirmed: "After this slice an event recorded from a newly assembled default prompt carries a date when
  the messages state one. A custom analysis frame gets the new format and rules only where it quotes
  `{{slot::format}}` and `{{slot::rules}}`, and a custom patch frame the relative-word rule only through
  `{{slot::rules}}`. A retry that replays a stored `input` sends the instructions that input was built with." Limits
  gained "Custom prompts and replays" (see A9).

### A2 — Rules: the unchanged-card promise contradicted D5 — fixed in plan

- Plan (Rules For Every Slice): "A chat with no dated event gets the same card as before: no anchor line, no label,
  the same token counts." Goal: "A chat that never states a date gets the card it gets today, byte for byte."
- Code: the card renders stored summaries and page bodies (`card.ts:115`, `:159`) and counts their text (`:257`). D5
  changes the wording of new records in every chat, so a later card differs through them.
- Correction, confirmed: "The same stored records with no valid date render as before: no anchor line, no label, the
  same token counts. D5 changes the wording of records written from then on, dated or not, so a later card can differ
  through them." Goal: "A chat whose events hold no date gets no label and no anchor line: its stored records render
  as they do today."

### A3 — D7: the next turn need not replace a wrong date — fixed in plan

- Plan (D7): "A wrong date on the newest event skews every label until the next event is recorded, which under the
  default cadence is the next turn."
- Code: a recording that repeats the last event is folded into it (`repeatsEvent`, `analysis.ts:494`, which compares
  participants, summary similarity, and source validity); admission then writes the stored event with more sources and
  drops the answer's story time (`:633`, `:673`). An undated newer event is skipped by D3 by design.
- First correction, disputed: D7 reworded, with a new rule in Slice 1 that a fold takes the answer's valid date. The
  rule itself was confirmed; A7 and A8 were filed against the sentences around it.
- Correction, confirmed: Slice 1 gained "**A folded repeat.** When admission folds a recording into the chat's last
  event (`repeatsEvent`), the written event is the stored one with more sources, and the answer's story time is
  dropped. The fold keeps the stored `storyTime.text` and takes the answer's `storyTime.date` when it holds a valid
  one, so an event's date stays the last date its messages state. An answer with no date leaves the stored date. The
  fold's comment in `analysis.ts`, which says everything else on the event stays, is updated with it." with a test
  line under `analysis.test.ts`. D7's closing sentences are in A8.
- The rule is new behavior, checked against the code: the draft is in scope at the fold (`analysis.ts:571`, `:673`);
  admission is recomputed against fresh records before the commit (`writer.ts:957`), the whole event enters the change
  set (`:1037`) and is stored whole with its `createdRevision` kept (`server/src/data/memoryStore.ts:516`, `:527`).
  The run keeps the parsed extraction, not the merged event (`writer.ts:884`), so the Log of an undated folded run
  shows no date while the Timeline shows the stored one, as it does for other fields today. Vector warming
  (`writer.ts:765`), repeat-specific patch behavior (`patches.ts:483`), a rebuild's model-free folds
  (`rebuild.ts:292`, `:321`), the anchor state (`shared/structuredMemory.ts:1785`), and `userCorrected`
  (`edits.ts:395`) do not read story time. A re-record and a historical or dry run fold nothing (`analysis.ts:635`,
  `writer.ts:673`) and take the draft whole (`analysis.ts:689`), date included.

### A7 — Rules: the legacy-event rule contradicted the fold — fixed in plan

- Plan (Rules For Every Slice, after the first correction): "An event stored before this plan has no date and gets no
  label until it is re-recorded or rebuilt."
- Code: `repeatsEvent` does not ask whether the last event has a date (`analysis.ts:494`), so the fold rule of A3 can
  date an event stored before the plan.
- Correction, confirmed: "An event stored before this plan stays undated, and so unlabelled, until it is re-recorded,
  rebuilt, or folded into by a repeat that carries a valid date (slice 1). No slice adds a migration or a backfill
  pass of its own."

### A8 — D7: a later recording does not always replace the story date — fixed in plan

- Plan (D7, after the first correction): "until a later recording carries a valid date: a new event, or a fold into
  that event".
- Code: a recording of an older window takes the historical path (`window.ts:190`, `recordJob.ts:253`) and its event
  is placed at its own, earlier source position (`retrieve.ts:997`), so under D3 it does not displace a later event.
- Correction, confirmed: "A wrong date on the event the story date is read from skews every label until another dated
  event has the greatest `place`, or a fold into that event carries a valid date (slice 1). An undated recording does
  not replace it, and neither does a recording of an older window, whose event is placed earlier. With a status line
  in every reply and the default cadence, the next recorded turn replaces it."

## P3

### A4 — Current State: what `placed` holds — fixed in plan

- Plan (Current State): "Retrieval has every active event in chat order. `prepareRetrieval` builds `placed`, the
  active, unsuppressed events with `place`, the position of their first source entry."
- Code: unreadable, stale, suppressed, and retracted events and events with no mapped source or greeting entry are
  left out; an event's sources are sorted newest first, so `place` is its newest matched entry; `placed` keeps the
  input's order (`retrieve.ts:979`, `:995`, `:999`, `:1010`). Events still inside the raw window are in `placed`; the
  lanes' own filter comes after (`:1019`). The newest dated event by `place` works as D3 says.
- Correction, confirmed: "Retrieval places the events a send can read. `prepareRetrieval` builds `placed`: the
  readable, active, unsuppressed events that have a current source entry or a greeting entry, events whose messages
  are still in the raw window included. `place` is the event's newest matched entry index; `placed` itself is not
  sorted."

### A5 — Slice 1: the guide that owns restore admission — fixed in plan

- Plan (Slice 1): "Guides: records (...), writer (...)."
- Code: `restore.ts` and restore admission belong to the lifecycle guide
  (`docs/structure/structured-memory/lifecycle.md:8`, `:178`), and slice 1 changes `isEvent` (`restore.ts:178`).
- Correction, confirmed: `lifecycle.md` joins the slice's heading, and the Guides line gains "lifecycle (restore
  admission keeps a valid date and refuses a malformed one)".

### A6 — Goal and Slice 2: the example disagreed with the label table — fixed in plan

- Plan (Goal, Slice 2): "`(17 days ago, 3월 17일 저녁) title: summary`".
- The table of the same slice gives 14 to 59 days as `floor(days / 7)` weeks.
- Correction, confirmed: both examples read "`(2 weeks ago, 3월 17일 저녁) title: summary`".

### A9 — Limits: a custom frame can hold its own instructions — fixed in plan

- Plan (Limits, after the first correction): "A preset's custom frame that does not quote the format and rules slots
  never asks for a date and never gets D5's rule".
- Code: `fillSlots` keeps a frame's literal text (`prompts.ts:426`), which can ask for either.
- Correction, confirmed: "A preset's custom frame gets the new format and rules only through the format and rules
  slots; a frame without them says what its author wrote. A replayed input asks what it asked when it was built."

## Also corrected

From the auditor's coverage of the panel, not a finding: Slice 3 now says the three guards that hide the story time
line while the text is empty show it for a date with no text, and that the run view's own story time type
(`src/ts/process/structuredMemory.svelte.ts:2318`) gains the field. Confirmed in the second turn.

## Noted, not recommended

- The fixture's story time type is declared in `story.ts:54`; `scriptedWriter.ts:231` passes it through.
- `memorySourceText` removes a comment's contents whole (`shared/structuredMemory.ts:1623`); the three status line
  forms the plan quotes keep their date text.
- Fixture files under `server/src/tests/fixtures/` resolve to the `self-host-server` guide in
  `docs/structure/ownership.json`; widening their test data changes no contract there.
