# Structured Memory Recent Timeline Plan

Status: drafted 2026-11-11 at `27dac4d50` from the owner's request; the owner decided D1 to D5 the same day
(Decisions). D6 to D13 are this plan's own, found against the code; the owner accepted the default of D7 and D8 the
same day. Audited against `e280c3904` on 2026-11-11
([report](../reports/audits/plan-runner/structured-memory-recent-timeline-2026-11-11.md)): six findings fixed here,
and one the owner accepted as a limitation (D13). Landed: 1 (`2760d9a59`), 2 (`17daaa59b`), 3 (`3634343f7`).

Sources: the owner's report (2026-11-11: a send forgets what happened a few turns ago, because an event that left the
raw window reaches the main model as its title alone; the owner's preset gives memory 50,000 tokens and each lane
10,000, and most of it stays empty); the read path under `server/src/prompt/memory/structured/` (`lanes.ts`,
`card.ts`, `retrieve.ts`, `step.ts`), `normalizeStructuredMemorySettings` in `shared/structuredMemory.ts`,
`resolveHypaV3Budget` in `shared/hypaV3Presets.ts`, the lane inputs of `src/lib/Setting/Pages/MemorySettings.svelte`,
and the writer's `RULES` in `prompts.ts`, read at `27dac4d50`; the
[read path guide](../structure/structured-memory/read.md); the token ledger of the
[2026-11-03 evaluation](../reports/measurements/structured-memory-2026-11-03.md). The identifiers are the anchors.
Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

A send tells the main model what happened recently, in order, with each event's summary, and spends the memory budget
the preset gives it.

- **A recent timeline.** The flow lane shows the newest events that left the raw window with their story time, title,
  and summary, under a token target of its own. The newest few also carry their key lines. Events past that stay
  listed by title, as today.
- **A budget that is used.** Lane targets default to shares of the memory maximum, so they grow with it, and what the
  other lanes leave goes to the timeline.
- **Settings a person can set.** One choice between shares and token inputs, a count of events that carry key lines,
  and an optional rule for how the writer picks key lines.

Not goals: a larger raw window (`windowTurns` sets it already); summaries of whole chapters or arcs; a change to when
the events lane opens; a change to the record shapes, to what the writer stores, or to the projection; stability of
the card's text for a provider's prompt cache (D9).

## Current State

- `rawWindow` keeps `windowTurns` assistant turns raw (default 3). History before it leaves the prompt where an
  active, unsuppressed event covers it (`coveredMessages`).
- `flowItems` in `retrieve.ts` lists the newest `flowEvents` placed events (default 8), in or out of the window, each
  as `flowLine`: `N turns ago: <title>`. The lane's target is `FLOW_TARGET`, `Number.MAX_SAFE_INTEGER`, so only
  `maximum` bounds it; `MemoryManifest.svelte` shows that target as spend alone. A flow item scores 0.
- `eventLine` (`(<story time>) <title>: <summary>` and the key lines) is rendered only by the events lane. `rankEvents`
  opens that lane when a user message of the query reads as past (`readsAsPast`) or an event's similarity reaches
  `eventOpenSimilarity` (0.6); closed, it offers nothing, whatever its target. `prepareRetrieval`'s `eligible` leaves
  out an event whose every source is inside the window with text.
- `evidenceItems` makes two passes: the sources of the events lane's candidates, each requiring
  `itemKey({ lane: "events", id })`, then older messages that left the prompt, by lexical match, requiring nothing.
- `spendLanes` runs a core round (lanes in `MEMORY_MANIFEST_LANES` order, each up to its target, an item that does not
  fit skipped) and then lends what is left by `score`. `buildMemoryCard` reserves the required lane, takes the frame
  off `maximum`, and while the rendered parts are over `maximum` drops the last admitted item.
- `laneTargets` holds `pages`, `events`, `evidence`, and `threads` as token counts (defaults 2000, 1500, 700, 300),
  whatever the memory maximum is. Their readers are `readBudget` (`lanes.ts`), `prepareRetrieval` and `retrieveLanes`
  (`retrieve.ts`), `step.ts` (the evidence reselection), `writer.ts` and `memoryTasks.ts` (which texts to warm).
- `MemorySettings.svelte` writes `normalizeStructuredMemorySettings(target.structured)` whole on every edit, so a
  preset edited once stores every default, and a stored value cannot be told from a default. The normalizer drops
  unknown keys.
- The measured shape (2026-11-03, 16,384 tokens of context, memory a fifth): the card nearly fills its 3,276 tokens
  (3,211 in English by the report's recount, 3,253 in Korean by the selection's tokenizer) and seven raw entries follow
  it, where HypaV3 sends a card of the same size and about 12,000 tokens of raw history. No measurement exists for a
  large maximum; that the owner's 50,000 stays mostly empty follows from the rules above and has not been measured.
- `RULES` in `prompts.ts` says a key line is copied verbatim and how long it may be. Nothing says which lines to
  choose.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_; routine slices name no Codex challenger.

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused command
  `pnpm --silent test:agent memory/structured structuredMemory StructuredMemory assemble normalizeCollections`, then
  `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, and `pnpm check:docs` for a
  guide edit. Run `pnpm check` again after the last test edit: Vitest does not type-check. V4 (`rg` each changed
  export and wire field) and V6 (each new test shown failing once with its guarded line broken).
- **Persisted values.** The lane id `flow`, the manifest's fields, the `laneTargets` keys, and the language keys that
  exist stay. A new settings field is optional; what its absence means is stated in the slice that adds it.
- **A new setting.** It follows `writer.md`'s recipe: `StructuredMemorySettings`,
  `normalizeStructuredMemorySettings`, the fresh-boot fixture, and `normalizeCollections.test.ts`.
- **A tab loaded before a slice.** Its bundle does not know the slice's fields, and `setStructured` stores what its
  normalizer keeps, so an edit of a structured memory setting in that tab returns the new fields to their defaults
  (D13). Nothing here changes that. Slice 1 records it in `writer.md` Limitations, for every writer setting.
- **Strings.** New user-visible text goes in `src/lang/en.ts` under `structuredMemory`, with its Korean in
  `src/lang/ko.ts` in the same slice, in the panel's terms (사건, 문서, 미결 사항, 기억).
- **The card's words.** Headings and labels the card adds are English, as `card.ts`'s header says. Field values stay
  as recorded.
- **Guide.** Each slice names its guide; that guide's `Invariants` apply, and the slice updates the sections and the
  module headers that name a changed contract. A guide stays under the 40,000-byte ceiling; `read.md` is at 33,311.
  Comments and test titles describe behavior, not this plan (STRUCTURE.md T5).
- **Manual checks.** Each slice lists the checks it cannot run. The slice report gives them to the owner as a
  checklist; what is still unrun when the plan closes moves to [manual checks](../backlog/manual-checks.md) under this
  plan's name.

## Order

Serial: 1 → 2 → 3 → 4. Slices 1 to 3 all edit `shared/structuredMemory.ts`, `MemorySettings.svelte`, the language
files, `boot-snapshot.json`, `normalizeCollections.test.ts`, `MemorySettings.structuredMemory.test.ts`, and
`writer.md`. Slices 1 and 2 also share `lanes.ts`, `retrieve.ts`, `step.ts`, their tests, `assemble.test.ts`, and
`read.md`; slices 2 and 3 share `writer.ts`; slices 2 and 4 share the evaluation fixture's `harness.ts`. Slice 4
measures what the first two built and may change slice 2's constants in `shared/structuredMemory.ts` and
`flowCandidates` in `retrieve.ts`.

If the run stops early, slice 1 stands alone: the timeline works under a token target set by hand.

## Slice 1. The flow lane shows summaries (_hard_, `structured-memory/read.md`)

Files: `shared/structuredMemory.ts`, `shared/contextReport.ts` (the comment that says the flow lane has no token
target), `server/src/prompt/memory/structured/lanes.ts`, `card.ts`, `retrieve.ts`, `step.ts`,
`src/lib/Setting/Pages/MemorySettings.svelte`, `src/lib/Others/StructuredMemory/MemoryManifest.svelte`,
`src/lang/en.ts`, `src/lang/ko.ts`, `src/ts/storage/tests/fixtures/boot/boot-snapshot.json`, `lanes.test.ts`,
`card.test.ts`, `retrieve.test.ts`, `server/src/tests/assemble.test.ts`,
`server/src/tests/normalizeCollections.test.ts`, `MemorySettings.structuredMemory.test.ts`, `read.md`, `writer.md`.

- **Settings.** `laneTargets.flow`, an integer ≥ 0, default 1500: the tokens the flow's full lines may take in the
  core round. 0 means no full line, which is today's card. `flowKeyLineEvents`, an integer ≥ 0, default 3 (D3).
  `flowEvents` keeps its field and now bounds the title lines.
- **Two forms.** A flow candidate has a title line, today's `flowLine`, and, when it is in `eligible`, a full line:
  `N turns ago: (<story time>) <title>: <summary>`, with the key lines in `eventLine`'s form on the newest
  `flowKeyLineEvents` candidates that have a full line. An event whose every source is inside the window has the title
  form alone (D12). Both forms keep the tag `itemTag({ lane: "flow", id })`. A manifest item's `reason` is `recent`
  for a title and `timeline` for a full line.
- **The run.** The run is the newest candidates shown in full, contiguous among those that have a full line. In the
  core round it grows, newest first, while the next full line fits the lane's target and `maximum`; it ends at the
  first that does not fit, so the timeline has no hole. After every other lane's core round and the lending, the run
  goes on with what is left of `maximum` (D2). `RETRIEVAL_LIMITS.flowCandidates` (200) bounds the full lines offered,
  since every candidate line is counted before spending.
- **The titles.** The newest `flowEvents` candidates outside the run are listed by title, counted against `maximum`
  alone and reserved in the core round before the pages lane spends, as today's titles are. When the run extends over a
  title, that title's tokens come back and the next older candidate takes a title if it fits. With a target of 0 the
  lane's items, the tokens it spends, its trimming, its text, and the target it reports (`Number.MAX_SAFE_INTEGER`) are
  exactly today's, and no full line is rendered or counted.
- **Never in full twice (D10).** The events lane does not admit an event the run holds. The run's extension passes
  over an event the events lane admitted and goes on. A full flow line satisfies an evidence item's `requires` for its
  event, so a source excerpt can follow its event in either lane.
- **No exclusion for a line shown in full.** `retrieveLanes` lists every placed event the events lane does not rank as
  `not-relevant`, before any spending, and `spendLanes` lists a candidate it passes over as `budget`. `step.ts` takes
  the events-lane exclusions of the events the card shows in full under `flow` out of `excluded`, on the card it
  keeps, before `sendManifest` counts and bounds them. An event listed by title keeps today's per-lane exclusion.
- **Over `maximum` after rendering.** `buildMemoryCard`'s last loop is unchanged: it drops the last admitted item. The
  admission order is the core round (the flow's run newest first, then its titles, then the other lanes), the lending,
  then the run's extension with the titles it moved; a title the extension turns into a full line takes its place in
  that order as an extension line. So the extension's oldest line goes first, and an evidence item still goes before the
  line it requires, in both cards a selection can build (`step.ts` builds a second one after an evidence reselection,
  with fresh keys). An excerpt whose event enters only in the extension is not admitted, since the evidence lane has
  spent by then. Core admissions outlast extension ones: an extension summary can go while a core title stays. Nothing
  is downgraded there.
- **The lane's switch.** `spendLanes` and `buildMemoryCard`'s frame read `target > 0` as a lane being on. The flow lane
  is on when `flowEvents` or the flow target is above 0, so its switch is its own, in `preflightMemoryCard` too, and a
  target of 0 keeps the titles. A title is never held to the lane's target, only to `maximum`.
- **The card.** With a flow target above 0 the block's heading reads
  `Recent events (oldest first; the last is just before the messages below):`. With a target of 0 it stays
  `Recent events:`. Lines stay ordered by place.
- **Settings page.** Two count inputs after `flowEvents`: the flow target with the other lane targets, and
  `flowKeyLineEvents`. `flowEvents` is relabelled for what it now bounds ("Recent events listed by title", "제목만
  나열할 최근 사건 수"). `MemoryManifest.svelte` shows the flow lane's spend against its target like the other lanes.
  It keeps the `Number.MAX_SAFE_INTEGER` case: a report is stored with its generation (`generationInfo.context`), so a
  message sent before this slice still holds that target.
- `read.md`: The read path, Limitations (the small-context row), Tests; the headers of `lanes.ts`, `card.ts`, and
  `retrieve.ts`. `writer.md`: the settings its State and Limitations name, and a Limitations entry for D13.
- Test:
  - `lanes.test.ts`: the run stops at the first full line over the target and admits no later, smaller one; what the
    other lanes leave extends it; the titles follow the run and move when it extends; a target of 0 gives today's
    titles.
  - `card.test.ts`: a full line with and without key lines; the heading under each target; a target of 0 gives
    today's card text and trim; over `maximum`, an excerpt goes before the flow line it requires and an extension line
    before a core one.
  - `retrieve.test.ts`: an event inside the window offers a title alone; key lines only on the newest
    `flowKeyLineEvents`; an event in the run is not in the events lane and not in `excluded`; its source excerpt is
    admitted through the flow line.
  - `assemble.test.ts`: a send whose events left the window carries their summaries in the card, the manifest items
    read `timeline`, and with the events lane closed none of those events is in the report's exclusions or its
    `excludedTotal`.
  - `normalizeCollections.test.ts`: the two fields' defaults and bounds. `MemorySettings.structuredMemory.test.ts`:
    the two inputs write their fields.
- Manual checks: a real chat's Preview shows summaries for the events just outside the window and titles past them;
  the settings inputs at phone width.

## Slice 2. Lane targets default to shares (_hard_, `structured-memory/read.md`, `settings-i18n.md`)

Files: `shared/structuredMemory.ts`, `lanes.ts`, `retrieve.ts`, `step.ts`,
`server/src/prompt/memory/structured/writer.ts`, `server/src/prompt/memory/memoryTasks.ts`, `MemorySettings.svelte`,
`src/lang/en.ts`, `src/lang/ko.ts`, `boot-snapshot.json`, `lanes.test.ts`, `retrieve.test.ts`,
`normalizeCollections.test.ts`, `MemorySettings.structuredMemory.test.ts`,
`server/src/tests/fixtures/memory/structured/harness.ts`, the tests that set `laneTargets`
(`memoryJobs.test.ts`, `memoryTaskHost.test.ts`, `memoryTasks.test.ts`, `structuredMemoryRoutes.test.ts`,
`assemble.test.ts`), `read.md`, `writer.md`.

- **The setting.** `laneSplit`: `"auto"` or `"manual"`. Absent or invalid reads `"auto"` (D7). The stored
  `laneTargets` are never rewritten by the mode, so `manual` shows the numbers a person entered before.
- **The shares (D8).** `STRUCTURED_MEMORY_LANE_SHARES` in `shared/structuredMemory.ts`: flow 0.40, pages 0.30, events
  0.15, evidence 0.10, threads 0.05. `resolveLaneTargets(settings, maximum)` answers the five targets: under `auto`
  each is `floor(maximum × share)`, under `manual` the stored counts. `requiredCap` is no share: it stays the count at
  which a send refuses.
- **One reader.** `readBudget` answers the resolved targets, and every reader of `laneTargets` listed under Current
  State takes them from the resolver: retrieval through its input, `step.ts`'s evidence reselection, and the two
  warming sites, which have no send and so no maximum and ask only whether a lane is on. The evaluation fixture's
  `harness.ts` calls `retrieveLanes` itself for its diagnostics and passes the targets resolved from the same maximum
  as its selection. Under `auto` every lane is
  on; a person turns one off by choosing `manual` and entering 0.
- **Lending is unchanged.** The other lanes lend by score first; the flow's run takes what is left last (slice 1).
  The shares decide only the core round, which is why a share set badly wastes nothing.
- **Settings page.** A select for `laneSplit` above the lane inputs. Under `auto` the five token inputs are hidden and
  one line states the shares; under `manual` they show. `flowEvents`, `flowKeyLineEvents`, and `requiredCap` show in
  both.
- `read.md`: The read path, State; `writer.md`: Limitations (the lane targets are starting values); the header of
  `lanes.ts`.
- Test:
  - `lanes.test.ts`: `auto` targets follow `maximum`; `manual` answers the stored counts; `auto` ignores a stored 0.
  - `retrieve.test.ts`: retrieval reads its targets from the input, not from `settings.laneTargets`.
  - `normalizeCollections.test.ts`: an absent `laneSplit` is `auto`; `laneTargets` survive a switch both ways.
  - `MemorySettings.structuredMemory.test.ts`: the select hides and shows the inputs and keeps their values.
  - The tests that set `laneTargets` to shape a card set `laneSplit: "manual"`.
- Manual checks: the owner's preset (50,000 tokens) under `auto`, read in Preview's lane spend; a preset in ratio
  mode on a 16,384-token model.

## Slice 3. An optional rule for choosing key lines (_small_, `structured-memory/writer.md`)

Files: `shared/structuredMemory.ts`, `server/src/prompt/memory/structured/prompts.ts`,
`server/src/prompt/memory/structured/writer.ts`, `MemorySettings.svelte`,
`src/lang/en.ts`, `src/lang/ko.ts`, `boot-snapshot.json`, `prompts.test.ts`, `normalizeCollections.test.ts`,
`MemorySettings.structuredMemory.test.ts`, `writer.md`.

- **The setting (D4).** `keyLineGuidance`, a boolean, default `false`. Off, the writer's prompt is today's.
- **The rule.** On, the analysis call's `rules` slot gains one line: choose the lines that carry a decision, a
  promise, a revealed fact, or a feeling, and leave out greetings and filler. It is part of the slot's text, so a
  custom frame that holds `{{slot::rules}}` gets it too. `analysisSlots` takes it as an optional input, and
  `writer.ts`, which reads the settings and calls `analysisSlots` for the default and the custom frame alike, passes
  `keyLineGuidance`; the test run goes through the same call. The default-prompts route answers the rule text without
  the line. The patch and compaction calls return no key lines and are unchanged.
- It changes what later runs record. Stored events keep their key lines; a re-record or a rebuild applies the rule.
- **Settings page.** A checkbox by the instructions, with a help line saying it applies to events recorded from then
  on.
- `writer.md`: Pages and calls, and State.
- Test: `prompts.test.ts`: the analysis `rules` slot holds the line only when the setting is on, in the default frame
  and in a custom one; the patch frame never does. `normalizeCollections.test.ts`: the default.
  `MemorySettings.structuredMemory.test.ts`: the checkbox writes the field.
- Manual checks: with a real `memory` model, the key lines of new events before and after turning it on.

## Slice 4. Measure the card (_small_, `structured-memory/read.md`)

Files: `util/memoryEval.mjs`, `server/src/tests/fixtures/memory/structured/` (the measurement and its README), a new
report `docs/reports/measurements/structured-memory-timeline-<date>.md`, `shared/structuredMemory.ts` if the shares
change, `retrieve.ts` if `flowCandidates` changes, and `read.md`.

- With `node util/memoryEval.mjs --lang ko,en --turns 100,1000`, the token ledger's send rows again at 16,384 and
  32,768 tokens of context, and at a memory maximum of 50,000: per lane, target and spend; the events the run holds
  and the titles after it; the card's tokens; `selectMemory`'s time with `flowCandidates` lines counted. The tool gains
  what it lacks to print those rows.
- The same rows with `laneSplit: "manual"`, `laneTargets.flow` 0, and the old targets, which slice 1 pins as today's
  card (items, spending, trimming, and text), so the report shows before and after from one run.
- How many of the events lane's candidates the run already held (D11).
- The report states what the pages lane lost to the flow's share at 16,384, and whether the `threads` lane still
  starves there (`read.md` Limitations). If the pages lane loses a page that was on stage, the slice lowers the flow
  share and says so (D8). If counting 200 lines moves `selectMemory` past the times `read.md` records, it lowers
  `flowCandidates`.
- The owner settled both corrections after the first run (D14): the shares move to flow 0.25 and pages 0.45, and
  `flowCandidates` stays 200; the report and `read.md` Limitations record what each leaves.
- `read.md`: Limitations cites the report for the small-context row and the selection time.
- The real-model question, whether replies recall recent events better, is not answered here: it joins the open A/B
  in [manual checks](../backlog/manual-checks.md).

## Decisions

The owner decided D1 to D5 on 2026-11-11, and accepted the default of D7 and D8 and the limitation of D13 the same
day; D14 is the owner's answer to slice 4's first run.

- D1. The flow lane becomes the recent timeline: summaries under a token target, events past it by title, their count
  set by `flowEvents`.
- D2. Lane targets default to shares of the memory maximum, what the other lanes leave goes to the timeline, and the
  token inputs stay as the other mode.
- D3. Key lines ride on the newest K events of the timeline, K a setting. "Key lines when room is left" was dropped:
  with D2 a long chat always has another summary to add, so no room would ever be left for them.
- D4. A rule for which key lines the writer chooses is an option, off by default: on the newest K events the lines as
  the writer picks them today serve better.
- D5. The raw window stays as it is; `windowTurns` already sets it.
- D6. The lane keeps the id `flow` and no lane is added, so a report, a tab, and a test that name lanes keep working.
- D7. An absent `laneSplit` is `auto`, for existing presets too. A stored value cannot be told from a default, the
  default is what this plan is for, and a person's numbers are one select away.
- D8. The shares are 40, 30, 15, 10, 5, fixed in code and not a setting; slice 4 may move them.
- D9. Every flow line keeps `N turns ago`. The label changes on every turn, as today's titles do, and the scene line
  before it can change too, so the card's stable part is not byte-stable now and this plan does not make it so.
- D10. An event is shown in full once: in the run, or in the events lane.
- D11. The events lane opens as today. With the run holding recent events, it is left to recall older ones. It ranks
  its 48 candidates before the run is known, so run events can take candidate places; slice 4 counts them.
- D12. An event whose sources are all inside the window stays a title: the prompt holds its text.
- D13. A tab loaded before a settings field existed drops that field on its next edit of a structured memory setting,
  and the field reads as its default from then on. That is how every writer setting added so far behaves, it needs an
  edit in the stale tab, a reload avoids it, and no record is touched. The owner accepted it on 2026-11-11 (audit
  AUD-2) over a merge in the resource store's write paths, which would also end "omitted means reset".
- D14. Slice 4's first run showed that its two corrections cannot both hold with the Goal: at 16,384 tokens of context
  a 1,000-turn Korean chat loses an on-stage page at every share that leaves a timeline of more than two events, and at
  a maximum of 50,000 the run reaches `flowCandidates`, so a lower bound leaves that budget unspent. The owner chose
  shares of flow 0.25 and pages 0.45 (events, evidence, and threads unchanged), with the page loss that remains recorded
  in `read.md` Limitations, and kept `flowCandidates` at 200, with the selection time its counting adds recorded there
  too, on 2026-11-11.

## Not In This Plan

- A raw window measured in tokens, or one that keeps history until the context is full.
- Chapter or arc summaries of what is older than the timeline.
- Opening the events lane more often, and any change to its thresholds.
- Shares as a setting, or a share per chat.
- A change to `eventSummaryChars`, `keyLinesPerEvent`, or anything the writer stores.
- Text that stays byte-stable for a provider's prompt cache.

## Open Questions

None open. The owner answered D7 and D8 on 2026-11-11.
